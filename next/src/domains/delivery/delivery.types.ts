/**
 * API and domain types for the delivery method, zone, shipment, and
 * tracking domain. Database row types remain generated and separate.
 */

export interface DeliveryMethodRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly name: string;
  readonly description: string | null;
  readonly priceMinor: string;
  readonly estimatedTime: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeliveryMethod extends Omit<DeliveryMethodRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDeliveryMethodInput {
  readonly storeId: string;
  readonly name: string;
  readonly description?: string | null;
  readonly priceMinor?: number;
  readonly estimatedTime?: string | null;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

export interface UpdateDeliveryMethodInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly priceMinor?: number;
  readonly estimatedTime?: string | null;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

export interface DeliveryZoneRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly locationId: string;
  readonly zipCode: string;
  readonly feeMinor: string;
  readonly minOrderMinor: string | null;
  readonly estimatedMinutes: number | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeliveryZone extends Omit<DeliveryZoneRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateDeliveryZoneInput {
  readonly storeId: string;
  readonly locationId: string;
  readonly zipCode: string;
  readonly feeMinor?: number;
  readonly minOrderMinor?: number | null;
  readonly estimatedMinutes?: number | null;
  readonly isActive?: boolean;
}

export interface UpdateDeliveryZoneInput {
  readonly zipCode?: string;
  readonly feeMinor?: number;
  readonly minOrderMinor?: number | null;
  readonly estimatedMinutes?: number | null;
  readonly isActive?: boolean;
}

export interface ZoneMatch {
  readonly feeMinor: string;
  readonly minOrderMinor: string | null;
  readonly estimatedMinutes: number | null;
}

// ---------------------------------------------------------------------------
// Carrier rates / shipments (Shipbubble)
// ---------------------------------------------------------------------------

export interface DeliveryParcel {
  readonly name?: string;
  readonly quantity: number;
  readonly weight: number;
  readonly declaredValueMinor?: number;
}

export interface DeliveryAddress {
  readonly name?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly addressLine1?: string;
  readonly city?: string;
  readonly state?: string;
  readonly countryCode?: string;
  readonly postalCode?: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface CarrierRateRequest {
  readonly destination: DeliveryAddress;
  readonly parcels: readonly DeliveryParcel[];
}

export interface CarrierRate {
  readonly provider: "shipbubble";
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
}

export type DeliveryStatus = "pending" | "booked" | "in_transit" | "delivered" | "failed" | "cancelled";

export interface DeliveryRow {
  readonly id: string;
  readonly businessId: string;
  readonly orderId: string;
  readonly fulfillmentId: string | null;
  readonly storeId: string;
  readonly deliveryMethodId: string | null;
  readonly provider: "shipbubble" | null;
  readonly status: DeliveryStatus;
  readonly courierName: string | null;
  readonly serviceCode: string | null;
  readonly courierId: string | null;
  readonly trackingCode: string | null;
  readonly trackingUrl: string | null;
  readonly labelUrl: string | null;
  readonly feeMinor: string;
  readonly destination: DeliveryAddress;
  readonly events: DeliveryTrackingEvent[];
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Delivery extends Omit<DeliveryRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryTrackingEvent {
  readonly location: string;
  readonly message: string;
  readonly captured: string;
}

export interface CreateShipmentInput {
  readonly orderId: string;
  readonly fulfillmentId?: string | null;
  readonly storeId: string;
  readonly destination: DeliveryAddress & { readonly addressLine1: string; readonly city: string; readonly state: string };
  readonly parcels: readonly DeliveryParcel[];
  readonly serviceCode: string;
  readonly courierId: string;
  readonly rate: CarrierRate;
}

export interface DeliveryOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}
