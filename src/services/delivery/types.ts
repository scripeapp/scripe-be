export interface DeliveryRateRequest {
  destination: {
    city: string;
    state: string;
    country: string;
    postal_code?: string;
    address_line_1?: string;
    latitude?: number;
    longitude?: number;
    name?: string;
    phone?: string;
    email?: string;
    /** Cached Shipbubble address_code — skips re-validating the receiver. */
    address_code?: number;
  };
  parcels: Array<{
    name?: string;
    quantity: number;
    weight: number;
    declared_value?: number;
  }>;
  sender?: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    /** Cached Shipbubble address_code — skips re-validating the sender. */
    address_code?: number;
  };
}

export interface DeliveryRate {
  provider: string;
  service_name: string;
  service_code: string;
  courier_id: string;
  price: number;
  currency: string;
  estimated_time: string;
  description?: string;
}

export interface DeliveryRatesResult {
  rates: DeliveryRate[];
  /** Validated receiver address_code — cache it on the saved address to skip
   *  re-validating on future checkouts. */
  receiverAddressCode: number;
}

export interface CreateShipmentRequest {
  rate: DeliveryRate;
  destination: {
    name: string;
    phone: string;
    email?: string;
    city: string;
    state: string;
    country: string;
    address_line_1: string;
    address_line_2?: string;
    postal_code?: string;
  };
  parcels: DeliveryRateRequest['parcels'];
  reference: string;
  sender?: {
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    /** Cached Shipbubble address_code — skips re-validating the sender. */
    address_code?: number;
  };
}

export interface CreateShipmentResult {
  order_id: string;
  tracking_url: string;
  tracking_code: string;
  courier_name: string;
  label_url?: string;
}

export interface DeliveryProvider {
  readonly name: string;
  getRates(request: DeliveryRateRequest): Promise<DeliveryRatesResult>;
  validateAddress(details: {
    name: string;
    phone: string;
    email: string;
    address: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{ address_code: number; formatted_address: string }>;
  createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult>;
  getTracking(orderId: string): Promise<{
    status: string;
    tracking_url: string;
    events: Array<{ location: string; message: string; captured: string }>;
  }>;
}
