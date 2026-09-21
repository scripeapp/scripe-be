import { ShipbubbleDeliveryProvider } from "./providers/shipbubble-delivery-provider.js";

export interface ValidatedCarrierAddress {
  readonly addressCode: number;
  readonly formattedAddress: string;
}

export interface CarrierAddressInput {
  readonly name: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface CarrierParty {
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly address: string;
  /** Skips re-validating with the carrier when already known. */
  readonly addressCode?: number;
}

export interface CarrierParcel {
  readonly name?: string;
  readonly quantity: number;
  readonly weight: number;
  readonly declaredValueMinor?: number;
}

export interface CarrierRateRequest {
  readonly sender: CarrierParty;
  readonly destination: {
    readonly name?: string;
    readonly phone?: string;
    readonly email?: string;
    readonly addressLine1?: string;
    readonly city?: string;
    readonly state?: string;
    readonly countryCode?: string;
    readonly latitude?: number;
    readonly longitude?: number;
    readonly addressCode?: number;
  };
  readonly parcels: readonly CarrierParcel[];
}

export interface CarrierRate {
  readonly serviceName: string;
  readonly serviceCode: string;
  readonly courierId: string;
  readonly priceMinor: number;
  readonly currency: string;
  readonly estimatedTime: string;
  readonly description?: string;
}

export interface CarrierRatesResult {
  readonly rates: CarrierRate[];
  readonly receiverAddressCode: number;
}

export interface CreateCarrierShipmentRequest {
  readonly sender: CarrierParty;
  readonly destination: {
    readonly name: string;
    readonly phone: string;
    readonly email?: string;
    readonly addressLine1: string;
    readonly city: string;
    readonly state: string;
  };
  readonly parcels: readonly CarrierParcel[];
  readonly serviceCode: string;
  readonly courierId: string;
}

export interface CreatedCarrierShipment {
  readonly carrierOrderId: string;
  readonly trackingUrl: string;
  readonly trackingCode: string;
  readonly courierName: string;
  readonly labelUrl?: string;
}

export interface CarrierTrackingEvent {
  readonly location: string;
  readonly message: string;
  readonly captured: string;
}

export interface CarrierTrackingResult {
  readonly status: string;
  readonly trackingUrl: string;
  readonly events: CarrierTrackingEvent[];
}

/** Ported from legacy's DeliveryProvider interface (src/services/delivery/types.ts) - only one implementation exists (Shipbubble), same as legacy. */
export interface DeliveryCarrierGateway {
  readonly name: "shipbubble";
  validateAddress(input: CarrierAddressInput): Promise<ValidatedCarrierAddress>;
  getRates(input: CarrierRateRequest): Promise<CarrierRatesResult>;
  createShipment(input: CreateCarrierShipmentRequest): Promise<CreatedCarrierShipment>;
  getTracking(carrierOrderId: string): Promise<CarrierTrackingResult>;
}

export function getDeliveryCarrierGateway(): DeliveryCarrierGateway {
  return new ShipbubbleDeliveryProvider();
}
