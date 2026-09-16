import { shipbubbleConfig } from "../../../config/shipbubble";
import {
  DeliveryProvider,
  DeliveryRateRequest,
  DeliveryRate,
  DeliveryRatesResult,
  CreateShipmentRequest,
  CreateShipmentResult,
} from "../types";

interface SbAddressResult {
  address_code: number;
  formatted_address: string;
  city: string;
  state: string;
  country: string;
  latitude: number;
  longitude: number;
}

interface SbCourierRate {
  courier_id: string;
  courier_name: string;
  service_code: string;
  service_type: "pickup" | "dropoff";
  total: number;
  currency: string;
  delivery_eta: string;
  delivery_eta_time: string;
  pickup_eta: string;
  vat: number;
  insurance: { code: string; fee: number };
  discount: { percentage: number; symbol: string; discounted: number };
  waybill: boolean;
  tracking_level: number;
}

interface SbRatesResponse {
  status: string;
  data: {
    request_token: string;
    couriers: SbCourierRate[];
  };
}

interface SbLabelResponse {
  status: string;
  data: {
    order_id: string;
    courier: { name: string; email: string; phone: string };
    tracking_url: string;
    status: string;
    payment: { shipping_fee: number; currency: string };
  };
}

interface SbTrackingResponse {
  status: string;
  data: {
    results: Array<{
      order_id: string;
      status: string;
      courier: { tracking_code: string; name: string };
      tracking_url: string;
      events: Array<{ location: string; message: string; captured: string }>;
    }>;
  };
}

const API = shipbubbleConfig.baseUrl;
const REQUEST_TIMEOUT_MS = 30000;

async function sbRequest<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: Record<string, any> },
): Promise<T> {
  if (!shipbubbleConfig.apiKey) {
    throw Object.assign(
      new Error(
        "Shipbubble is not configured (missing SHIPBUBBLE_API_KEY). Delivery rates are unavailable.",
      ),
      { statusCode: 503 },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
      method: init.method,
      headers: {
        Accept: "application/json",
        "User-Agent": "surge-be",
        Authorization: `Bearer ${shipbubbleConfig.apiKey}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    // Network-level failure (DNS, TCP/TLS, timeout) — surface a clear,
    // actionable message instead of the opaque "fetch failed".
    const reason =
      err?.name === "TimeoutError"
        ? `request timed out after ${REQUEST_TIMEOUT_MS}ms`
        : err?.cause?.message || err?.message || "network error";
    throw Object.assign(new Error(`Could not reach Shipbubble (${reason})`), {
      statusCode: 502,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let detail = text || response.statusText;
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) {
        detail = parsed.message;
      }
    } catch (e) {
      console.log("[sbRequest Error]: ", e);
    }
    throw Object.assign(new Error(detail), { statusCode: response.status });
  }

  return response.json() as Promise<T>;
}

function sbPost<T>(path: string, body: Record<string, any>): Promise<T> {
  return sbRequest<T>(path, { method: "POST", body });
}

function sbGet<T>(path: string): Promise<T> {
  return sbRequest<T>(path, { method: "GET" });
}

/**
 * Shipbubble requires a "full name": letters only (no digits/symbols) and at
 * least two words. Strip disallowed characters and pad single-word names so
 * validation does not reject otherwise-valid store/customer names.
 */
function sanitizeName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw || "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const name = cleaned || fallback;
  return name.includes(" ") ? name : `${name} Ltd`;
}

/**
 * Shipbubble's address-validate failures are generic ("couldn't validate the
 * provided address"). Prefix the message with which address failed so the
 * cause (e.g. an unconfigured store pickup address) is obvious.
 */
/**
 * Resolve the sender (store pickup) from the request. The store's business
 * address is the single source of truth — there is no global fallback, so a
 * misconfigured store fails loudly instead of silently shipping from the
 * wrong origin.
 */
function resolveSender(request: { sender?: DeliveryRateRequest["sender"] }): {
  name?: string;
  phone?: string;
  email?: string;
  address: string;
  address_code?: number;
} {
  const sender = request.sender;
  if (!sender?.address) {
    throw Object.assign(
      new Error(
        "Store pickup address is not configured. Set your business address before using carrier delivery.",
      ),
      { statusCode: 400 },
    );
  }
  return {
    name: sender.name,
    phone: sender.phone,
    email: sender.email,
    address: sender.address,
    address_code: sender.address_code,
  };
}

function labelAddressError(err: any, which: string): Error {
  const base = err?.message || "Address validation failed";
  if (/validate the provided address/i.test(base)) {
    return Object.assign(
      new Error(`Could not validate the ${which} address. ${base}`),
      { statusCode: err?.statusCode || 400 },
    );
  }
  return err;
}

/**
 * Build Shipbubble package_items. Each item must have a name, description,
 * weight and amount, otherwise the rate/label request is rejected.
 */
function buildPackageItems(parcels: DeliveryRateRequest["parcels"]) {
  return parcels.map((p) => {
    const name = (p.name || "Item").trim() || "Item";
    return {
      name,
      description: name,
      unit_weight: String(Math.max(p.weight, 0.1)),
      unit_amount: String(Math.max(p.declared_value || 0, 1)),
      quantity: String(Math.max(p.quantity, 1)),
    };
  });
}

export class ShipbubbleProvider implements DeliveryProvider {
  readonly name = "shipbubble";

  async validateAddress(details: {
    name: string;
    phone: string;
    email: string;
    address: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{ address_code: number; formatted_address: string }> {
    const res = await sbPost<{
      status: string;
      data: SbAddressResult;
    }>("/shipping/address/validate", {
      name: details.name,
      phone: details.phone,
      email: details.email,
      address: details.address,
      // When coordinates are supplied (e.g. from Google Places), Shipbubble
      // validates against them for higher accuracy and ignores ambiguity in
      // the address string.
      ...(typeof details.latitude === "number" &&
      typeof details.longitude === "number"
        ? { latitude: details.latitude, longitude: details.longitude }
        : {}),
    });

    if (res.status !== "success" || !res.data) {
      throw new Error("Address validation failed");
    }

    return {
      address_code: res.data.address_code,
      formatted_address: res.data.formatted_address,
    };
  }

  private buildReceiverAddress(
    dest: DeliveryRateRequest["destination"],
  ): string {
    return [dest.address_line_1, dest.city, dest.state, dest.country]
      .filter(Boolean)
      .join(", ");
  }

  /**
   * Resolve the sender's Shipbubble address_code. Uses the cached code when
   * present (no API call / no wallet charge); otherwise validates the address
   * once.
   */
  private async resolveSenderCode(
    sender: ReturnType<typeof resolveSender>,
  ): Promise<number> {
    if (sender.address_code) return sender.address_code;
    const validated = await this.validateAddress({
      name: sanitizeName(sender.name, "Store Sender"),
      phone: sender.phone || "08000000000",
      email: sender.email || "store@hilaq.com",
      address: sender.address,
    }).catch((e) => {
      throw labelAddressError(e, "sender (store pickup)");
    });
    return validated.address_code;
  }

  /**
   * Resolve the receiver's Shipbubble address_code. Uses the cached code (from
   * a saved customer address) when present; otherwise validates once.
   */
  private async resolveReceiverCode(
    destination: DeliveryRateRequest["destination"],
    receiverAddress: string,
  ): Promise<number> {
    if (destination.address_code) return destination.address_code;
    const validated = await this.validateAddress({
      name: sanitizeName(destination.name, "Valued Customer"),
      phone: destination.phone || "08000000000",
      email: destination.email || "customer@example.com",
      address: receiverAddress,
      latitude: destination.latitude,
      longitude: destination.longitude,
    }).catch((e) => {
      throw labelAddressError(e, "delivery");
    });
    return validated.address_code;
  }

  async getRates(request: DeliveryRateRequest): Promise<DeliveryRatesResult> {
    const sender = resolveSender(request);
    const receiverAddress = this.buildReceiverAddress(request.destination);

    const [senderAddressCode, receiverAddressCode] = await Promise.all([
      this.resolveSenderCode(sender),
      this.resolveReceiverCode(request.destination, receiverAddress),
    ]);

    const pickupDate = new Date();
    pickupDate.setDate(pickupDate.getDate() + 1);
    const pickupDateStr = pickupDate.toISOString().split("T")[0];

    const res = await sbPost<SbRatesResponse>("/shipping/fetch_rates", {
      sender_address_code: senderAddressCode,
      reciever_address_code: receiverAddressCode,
      pickup_date: pickupDateStr,
      category_id: shipbubbleConfig.defaultCategoryId,
      package_items: buildPackageItems(request.parcels),
      package_dimension: shipbubbleConfig.defaultPackageDimensions,
    });

    if (res.status !== "success" || !res.data) {
      throw new Error("Failed to fetch shipping rates");
    }

    const markup = 1 + shipbubbleConfig.markupPercent / 100;

    const rates: DeliveryRate[] = res.data.couriers.map((c) => ({
      provider: "shipbubble",
      service_name: c.courier_name,
      service_code: c.service_code,
      courier_id: String(c.courier_id),
      price: Math.round(c.total * 100 * markup),
      currency: c.currency || "NGN",
      estimated_time: c.delivery_eta || "",
      description:
        c.service_type === "dropoff"
          ? "Drop off at nearest station"
          : "Pickup from your address",
    }));

    return { rates, receiverAddressCode };
  }

  async createShipment(
    request: CreateShipmentRequest,
  ): Promise<CreateShipmentResult> {
    const sender = resolveSender(request);
    const receiverAddress = [
      request.destination.address_line_1,
      request.destination.city,
      request.destination.state,
      request.destination.country,
    ]
      .filter(Boolean)
      .join(", ");

    const senderAddressCode = await this.resolveSenderCode(sender);

    const receiverValidated = await this.validateAddress({
      name: request.destination.name,
      phone: request.destination.phone,
      email: request.destination.email || "",
      address: receiverAddress,
    });

    const pickupDate = new Date();
    pickupDate.setDate(pickupDate.getDate() + 1);
    const pickupDateStr = pickupDate.toISOString().split("T")[0];

    const rates = await sbPost<SbRatesResponse>("/shipping/fetch_rates", {
      sender_address_code: senderAddressCode,
      reciever_address_code: receiverValidated.address_code,
      pickup_date: pickupDateStr,
      category_id: shipbubbleConfig.defaultCategoryId,
      package_items: buildPackageItems(request.parcels),
      package_dimension: shipbubbleConfig.defaultPackageDimensions,
    });

    if (rates.status !== "success" || !rates.data) {
      throw new Error("Failed to fetch rates for shipment creation");
    }

    const requestToken = rates.data.request_token;

    const res = await sbPost<SbLabelResponse>("/shipping/labels", {
      request_token: requestToken,
      service_code: request.rate.service_code,
      courier_id: request.rate.courier_id,
    });

    if (res.status !== "success" || !res.data) {
      throw new Error("Failed to create shipment label");
    }

    return {
      order_id: res.data.order_id,
      tracking_url: res.data.tracking_url,
      tracking_code: res.data.order_id,
      courier_name: res.data.courier.name,
    };
  }

  async getTracking(orderId: string): Promise<{
    status: string;
    tracking_url: string;
    events: Array<{ location: string; message: string; captured: string }>;
  }> {
    const res = await sbGet<SbTrackingResponse>(
      `/shipping/labels/list/${orderId}`,
    );

    if (res.status !== "success" || !res.data?.results?.[0]) {
      throw new Error("Failed to get tracking info");
    }

    const shipment = res.data.results[0];
    return {
      status: shipment.status,
      tracking_url: shipment.tracking_url,
      events: shipment.events || [],
    };
  }
}
