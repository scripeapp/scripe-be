import { ShipbubbleProvider } from "./providers/shipbubble.provider";
import {
  DeliveryRateRequest,
  DeliveryRatesResult,
  CreateShipmentRequest,
  CreateShipmentResult,
} from "./types";

export class DeliveryService {
  private provider = new ShipbubbleProvider();

  async getRates(request: DeliveryRateRequest): Promise<DeliveryRatesResult> {
    return this.provider.getRates(request);
  }

  async validateAddress(details: {
    name: string;
    phone: string;
    email: string;
    address: string;
    latitude?: number;
    longitude?: number;
  }): Promise<{ address_code: number; formatted_address: string }> {
    return this.provider.validateAddress(details);
  }

  async createShipment(request: CreateShipmentRequest): Promise<CreateShipmentResult> {
    return this.provider.createShipment(request);
  }

  async getTracking(orderId: string): Promise<{
    status: string;
    tracking_url: string;
    events: Array<{ location: string; message: string; captured: string }>;
  }> {
    return this.provider.getTracking(orderId);
  }
}
