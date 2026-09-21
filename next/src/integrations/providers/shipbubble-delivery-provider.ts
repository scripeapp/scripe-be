import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type {
  CarrierAddressInput,
  CarrierParcel,
  CarrierParty,
  CarrierRateRequest,
  CarrierRatesResult,
  CarrierTrackingResult,
  CreateCarrierShipmentRequest,
  CreatedCarrierShipment,
  DeliveryCarrierGateway,
  ValidatedCarrierAddress,
} from "../delivery-carrier.js";

interface SbAddressResponse {
  status: string;
  data: { address_code: number; formatted_address: string };
}

interface SbCourierRate {
  courier_id: string;
  courier_name: string;
  service_code: string;
  service_type: "pickup" | "dropoff";
  total: number;
  currency: string;
  delivery_eta: string;
}

interface SbRatesResponse {
  status: string;
  data: { request_token: string; couriers: SbCourierRate[] };
}

interface SbLabelResponse {
  status: string;
  data: { order_id: string; courier: { name: string }; tracking_url: string };
}

interface SbTrackingResponse {
  status: string;
  data: { results: { status: string; courier: { tracking_code: string }; tracking_url: string; events: { location: string; message: string; captured: string }[] }[] };
}

/**
 * Ported from legacy's src/services/delivery/providers/shipbubble.provider.ts.
 * Same request shape/endpoints; address_code caching (legacy cached it on
 * user_addresses to avoid repeat, wallet-charged validation calls) is not
 * carried over here - a deliberate simplification, not an oversight, since
 * caching would mean touching the parties domain's schema for a
 * micro-optimization; every rate/shipment call re-validates instead.
 */
export class ShipbubbleDeliveryProvider implements DeliveryCarrierGateway {
  readonly name = "shipbubble" as const;

  private apiKey(): string {
    const key = loadEnvironment().SHIPBUBBLE_API_KEY;
    if (!key) throw serviceUnavailableError("Shipbubble is not configured (missing SHIPBUBBLE_API_KEY).");
    return key;
  }

  private async request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const environment = loadEnvironment();
    let response: Response;
    try {
      response = await fetch(`${environment.SHIPBUBBLE_BASE_URL}${path}`, {
        method: body ? "POST" : "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey()}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError" ? "request timed out after 30000ms" : error instanceof Error ? error.message : "network error";
      throw serviceUnavailableError(`Could not reach Shipbubble (${reason})`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let detail = text || response.statusText;
      try {
        const parsed = JSON.parse(text) as { message?: string };
        if (parsed.message) detail = parsed.message;
      } catch {
        // non-JSON error body - fall back to the raw text/status
      }
      throw new Error(`Shipbubble request failed: ${detail}`);
    }
    return (await response.json()) as T;
  }

  /**
   * Shipbubble requires a "full name": letters only, at least two words.
   */
  private sanitizeName(raw: string | undefined, fallback: string): string {
    const cleaned = (raw ?? "").replace(/[^a-zA-Z\s]/g, " ").replace(/\s+/g, " ").trim();
    const name = cleaned || fallback;
    return name.includes(" ") ? name : `${name} Ltd`;
  }

  async validateAddress(input: CarrierAddressInput): Promise<ValidatedCarrierAddress> {
    const response = await this.request<SbAddressResponse>("/shipping/address/validate", {
      name: input.name,
      phone: input.phone,
      email: input.email,
      address: input.address,
      ...(typeof input.latitude === "number" && typeof input.longitude === "number" ? { latitude: input.latitude, longitude: input.longitude } : {}),
    });
    if (response.status !== "success" || !response.data) throw new Error("Address validation failed");
    return { addressCode: response.data.address_code, formattedAddress: response.data.formatted_address };
  }

  private async resolvePartyCode(party: CarrierParty, fallbackName: string, which: string): Promise<number> {
    if (party.addressCode) return party.addressCode;
    try {
      const validated = await this.validateAddress({
        name: this.sanitizeName(party.name, fallbackName),
        phone: party.phone || "08000000000",
        email: party.email || "unknown@example.com",
        address: party.address,
      });
      return validated.addressCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Address validation failed";
      throw new Error(`Could not validate the ${which} address. ${message}`);
    }
  }

  private buildPackageItems(parcels: readonly CarrierParcel[]) {
    return parcels.map((parcel) => {
      const name = (parcel.name || "Item").trim() || "Item";
      return {
        name,
        description: name,
        unit_weight: String(Math.max(parcel.weight, 0.1)),
        unit_amount: String(Math.max(parcel.declaredValueMinor ? parcel.declaredValueMinor / 100 : 0, 1)),
        quantity: String(Math.max(parcel.quantity, 1)),
      };
    });
  }

  private tomorrow(): string {
    const date = new Date();
    date.setDate(date.getDate() + 1);
    return date.toISOString().split("T")[0]!;
  }

  async getRates(input: CarrierRateRequest): Promise<CarrierRatesResult> {
    const environment = loadEnvironment();
    const destinationAddress = [input.destination.addressLine1, input.destination.city, input.destination.state, input.destination.countryCode].filter(Boolean).join(", ");

    const [senderAddressCode, receiverAddressCode] = await Promise.all([
      this.resolvePartyCode(input.sender, "Store Sender", "sender (store pickup)"),
      input.destination.addressCode
        ? Promise.resolve(input.destination.addressCode)
        : this.resolvePartyCode(
            { name: input.destination.name, phone: input.destination.phone, email: input.destination.email, address: destinationAddress },
            "Valued Customer",
            "delivery",
          ),
    ]);

    const response = await this.request<SbRatesResponse>("/shipping/fetch_rates", {
      sender_address_code: senderAddressCode,
      reciever_address_code: receiverAddressCode,
      pickup_date: this.tomorrow(),
      category_id: environment.SHIPBUBBLE_DEFAULT_CATEGORY_ID,
      package_items: this.buildPackageItems(input.parcels),
      package_dimension: { length: environment.SHIPBUBBLE_DEFAULT_PKG_LENGTH, width: environment.SHIPBUBBLE_DEFAULT_PKG_WIDTH, height: environment.SHIPBUBBLE_DEFAULT_PKG_HEIGHT },
    });
    if (response.status !== "success" || !response.data) throw new Error("Failed to fetch shipping rates");

    const markup = 1 + environment.SHIPBUBBLE_MARKUP_PERCENT / 100;
    const rates = response.data.couriers.map((courier) => ({
      serviceName: courier.courier_name,
      serviceCode: courier.service_code,
      courierId: String(courier.courier_id),
      priceMinor: Math.round(courier.total * 100 * markup),
      currency: courier.currency || "NGN",
      estimatedTime: courier.delivery_eta || "",
      description: courier.service_type === "dropoff" ? "Drop off at nearest station" : "Pickup from your address",
    }));
    return { rates, receiverAddressCode };
  }

  async createShipment(input: CreateCarrierShipmentRequest): Promise<CreatedCarrierShipment> {
    const environment = loadEnvironment();
    const receiverAddress = [input.destination.addressLine1, input.destination.city, input.destination.state].filter(Boolean).join(", ");

    const senderAddressCode = await this.resolvePartyCode(input.sender, "Store Sender", "sender (store pickup)");
    const receiver = await this.validateAddress({ name: input.destination.name, phone: input.destination.phone, email: input.destination.email || "", address: receiverAddress });

    const rates = await this.request<SbRatesResponse>("/shipping/fetch_rates", {
      sender_address_code: senderAddressCode,
      reciever_address_code: receiver.addressCode,
      pickup_date: this.tomorrow(),
      category_id: environment.SHIPBUBBLE_DEFAULT_CATEGORY_ID,
      package_items: this.buildPackageItems(input.parcels),
      package_dimension: { length: environment.SHIPBUBBLE_DEFAULT_PKG_LENGTH, width: environment.SHIPBUBBLE_DEFAULT_PKG_WIDTH, height: environment.SHIPBUBBLE_DEFAULT_PKG_HEIGHT },
    });
    if (rates.status !== "success" || !rates.data) throw new Error("Failed to fetch rates for shipment creation");

    const response = await this.request<SbLabelResponse>("/shipping/labels", {
      request_token: rates.data.request_token,
      service_code: input.serviceCode,
      courier_id: input.courierId,
    });
    if (response.status !== "success" || !response.data) throw new Error("Failed to create shipment label");

    return { carrierOrderId: response.data.order_id, trackingUrl: response.data.tracking_url, trackingCode: response.data.order_id, courierName: response.data.courier.name };
  }

  async getTracking(carrierOrderId: string): Promise<CarrierTrackingResult> {
    const response = await this.request<SbTrackingResponse>(`/shipping/labels/list/${carrierOrderId}`);
    const shipment = response.data?.results?.[0];
    if (response.status !== "success" || !shipment) throw new Error("Failed to get tracking info");
    return { status: shipment.status, trackingUrl: shipment.tracking_url, events: shipment.events || [] };
  }
}
