import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { getDeliveryCarrierGateway, type CarrierParty } from "../../integrations/delivery-carrier.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./delivery.repository.js";
import type {
  CarrierRatesResult,
  CreateDeliveryMethodInput,
  CreateDeliveryZoneInput,
  CreateShipmentInput,
  Delivery,
  DeliveryMethod,
  DeliveryMethodRow,
  DeliveryOperation,
  DeliveryRow,
  DeliveryZone,
  DeliveryZoneRow,
  UpdateDeliveryMethodInput,
  UpdateDeliveryZoneInput,
  ZoneMatch,
} from "./delivery.types.js";

export class DeliveryService {
  constructor(private readonly database: Database) {}

  // ---------------------------------------------------------------------
  // Delivery methods
  // ---------------------------------------------------------------------

  async listMethods(operation: DeliveryOperation, storeId: string | undefined): Promise<DeliveryMethod[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      return (await repository.listMethods(context, operation.businessId, storeId)).map(toMethod);
    });
  }

  async createMethod(operation: DeliveryOperation, input: CreateDeliveryMethodInput): Promise<DeliveryMethod> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const created = await repository.createMethod(context, operation.businessId, input);
      return toMethod(created);
    });
  }

  async updateMethod(operation: DeliveryOperation, methodId: string, input: UpdateDeliveryMethodInput): Promise<DeliveryMethod> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const updated = await repository.updateMethod(context, operation.businessId, methodId, input);
      if (!updated) throw notFoundError("Delivery method not found");
      return toMethod(updated);
    });
  }

  async deactivateMethod(operation: DeliveryOperation, methodId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const deactivated = await repository.deactivateMethod(context, operation.businessId, methodId);
      if (!deactivated) throw notFoundError("Delivery method not found");
    });
  }

  async reorderMethods(operation: DeliveryOperation, storeId: string, orderedIds: readonly string[]): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const matching = await repository.countMethodsMatching(context, operation.businessId, storeId, orderedIds);
      if (matching !== orderedIds.length) throw validationError("One or more delivery methods not found for this store");
      await repository.reorderMethods(context, operation.businessId, storeId, orderedIds);
    });
  }

  async setCarrierDeliveryEnabled(operation: DeliveryOperation, storeId: string, enabled: boolean): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const updated = await repository.setCarrierDeliveryEnabled(context, operation.businessId, storeId, enabled);
      if (!updated) throw notFoundError("Store not found");
    });
  }

  // ---------------------------------------------------------------------
  // Delivery zones
  // ---------------------------------------------------------------------

  async listZones(operation: DeliveryOperation, storeId: string | undefined): Promise<DeliveryZone[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      return (await repository.listZones(context, operation.businessId, storeId)).map(toZone);
    });
  }

  async createZone(operation: DeliveryOperation, input: CreateDeliveryZoneInput): Promise<DeliveryZone> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const created = await repository.createZone(context, operation.businessId, input);
      return toZone(created);
    });
  }

  async updateZone(operation: DeliveryOperation, zoneId: string, input: UpdateDeliveryZoneInput): Promise<DeliveryZone> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const updated = await repository.updateZone(context, operation.businessId, zoneId, input);
      if (!updated) throw notFoundError("Delivery zone not found");
      return toZone(updated);
    });
  }

  async deleteZone(operation: DeliveryOperation, zoneId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const deleted = await repository.deleteZone(context, operation.businessId, zoneId);
      if (!deleted) throw notFoundError("Delivery zone not found");
    });
  }

  /** Zip-exact zone lookup used at checkout time - returns undefined (not an error) when no zone matches, so the caller falls back to a flat delivery method. */
  async matchZone(operation: DeliveryOperation, storeId: string, locationId: string, zipCode: string): Promise<ZoneMatch | undefined> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      return repository.matchZone(context, operation.businessId, storeId, locationId, zipCode);
    });
  }

  // ---------------------------------------------------------------------
  // Carrier rates and shipments (Shipbubble)
  // ---------------------------------------------------------------------

  async getRates(operation: DeliveryOperation, input: CreateShipmentInput["destination"] & { storeId: string; parcels: CreateShipmentInput["parcels"] }): Promise<CarrierRatesResult> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      const sender = await this.resolveSenderAddress(context, operation.businessId, input.storeId);
      const gateway = getDeliveryCarrierGateway();
      const result = await gateway.getRates({
        sender,
        destination: { name: input.name, phone: input.phone, email: input.email, addressLine1: input.addressLine1, city: input.city, state: input.state, latitude: input.latitude, longitude: input.longitude },
        parcels: input.parcels,
      });
      return { rates: result.rates.map((rate) => ({ ...rate, provider: "shipbubble" as const })) };
    });
  }

  async createShipment(operation: DeliveryOperation, input: CreateShipmentInput): Promise<Delivery> {
    const prepared = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.manage");
      const sender = await this.resolveSenderAddress(context, operation.businessId, input.storeId);
      const delivery = await repository.createDelivery(context, operation.businessId, operation.userId, {
        orderId: input.orderId,
        fulfillmentId: input.fulfillmentId ?? null,
        storeId: input.storeId,
        deliveryMethodId: null,
        provider: "shipbubble",
        destination: input.destination,
        feeMinor: input.rate.priceMinor,
      });
      return { delivery, sender };
    });

    const gateway = getDeliveryCarrierGateway();
    const shipment = await gateway.createShipment({
      sender: prepared.sender,
      destination: { name: input.destination.name!, phone: input.destination.phone!, email: input.destination.email, addressLine1: input.destination.addressLine1, city: input.destination.city, state: input.destination.state },
      parcels: input.parcels,
      serviceCode: input.serviceCode,
      courierId: input.courierId,
    });

    return this.run(operation, async (context) => {
      const updated = await repository.markDeliveryBooked(context, prepared.delivery.id, {
        courierName: shipment.courierName,
        serviceCode: input.serviceCode,
        courierId: input.courierId,
        trackingCode: shipment.trackingCode,
        trackingUrl: shipment.trackingUrl,
        labelUrl: shipment.labelUrl ?? null,
      });
      await auditRepository.log(context, {
        businessId: operation.businessId,
        actorUserId: operation.userId,
        action: "delivery.shipment.create",
        targetType: "delivery",
        targetId: prepared.delivery.id,
        metadata: { orderId: input.orderId, trackingCode: shipment.trackingCode },
        requestId: operation.requestId,
      });
      return toDelivery(updated!);
    });
  }

  async listDeliveriesForOrder(operation: DeliveryOperation, orderId: string): Promise<Delivery[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      return (await repository.listDeliveriesForOrder(context, operation.businessId, orderId)).map(toDelivery);
    });
  }

  async refreshTracking(operation: DeliveryOperation, deliveryId: string): Promise<Delivery> {
    const existing = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "delivery.read");
      const found = await repository.findDelivery(context, operation.businessId, deliveryId);
      if (!found) throw notFoundError("Delivery not found");
      if (!found.trackingCode) throw validationError("This delivery has not been booked with a carrier yet");
      return found;
    });

    const gateway = getDeliveryCarrierGateway();
    const tracking = await gateway.getTracking(existing.trackingCode!);

    return this.run(operation, async (context) => {
      const latestEvent = tracking.events[tracking.events.length - 1];
      const updated = latestEvent
        ? await repository.appendTrackingEvent(context, deliveryId, mapCarrierStatus(tracking.status), latestEvent)
        : existing;
      return toDelivery(updated as DeliveryRow);
    });
  }

  private async resolveSenderAddress(context: DatabaseContext, businessId: string, storeId: string): Promise<CarrierParty> {
    const location = await repository.findDefaultLocationAddress(context, businessId, storeId);
    if (!location?.addressLine1) throw validationError("Set your store's pickup address before using carrier delivery.");
    return {
      name: location.name ?? undefined,
      phone: location.phone ?? undefined,
      address: [location.addressLine1, location.city, location.state, location.countryCode].filter(Boolean).join(", "),
    };
  }

  private async run<T>(operation: DeliveryOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

/** Shipbubble's free-text carrier status strings collapse to our fixed enum; unrecognized values are treated as still in transit rather than silently dropped. */
function mapCarrierStatus(carrierStatus: string): "booked" | "in_transit" | "delivered" | "failed" {
  const normalized = carrierStatus.toLowerCase();
  if (normalized.includes("deliver")) return "delivered";
  if (normalized.includes("fail") || normalized.includes("cancel")) return "failed";
  if (normalized.includes("transit") || normalized.includes("picked")) return "in_transit";
  return "booked";
}

function toMethod(row: DeliveryMethodRow): DeliveryMethod {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toZone(row: DeliveryZoneRow): DeliveryZone {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toDelivery(row: DeliveryRow): Delivery {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}
