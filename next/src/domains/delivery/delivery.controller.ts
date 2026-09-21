import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./delivery.schemas.js";
import type { DeliveryService } from "./delivery.service.js";
import type { DeliveryOperation } from "./delivery.types.js";

export class DeliveryController {
  constructor(private readonly service: DeliveryService) {}

  // Methods
  readonly listMethods = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { methods: await this.service.listMethods(this.operation(request, businessId), schemas.listMethodsQuerySchema.parse(request.query).storeId) };
  });
  readonly createMethod = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { method: await this.service.createMethod(this.operation(request, businessId), schemas.createMethodSchema.parse(request.body)) };
  }, 201);
  readonly updateMethod = this.handle(async (request) => {
    const { businessId, methodId } = schemas.methodParamsSchema.parse(request.params);
    return { method: await this.service.updateMethod(this.operation(request, businessId), methodId, schemas.updateMethodSchema.parse(request.body)) };
  });
  readonly deactivateMethod = this.handle(async (request) => {
    const { businessId, methodId } = schemas.methodParamsSchema.parse(request.params);
    await this.service.deactivateMethod(this.operation(request, businessId), methodId);
    return null;
  });
  readonly reorderMethods = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { storeId, order } = schemas.reorderMethodsSchema.parse(request.body);
    await this.service.reorderMethods(this.operation(request, businessId), storeId, order);
    return null;
  });
  readonly setCarrierDelivery = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { storeId, enabled } = schemas.setCarrierDeliverySchema.parse(request.body);
    await this.service.setCarrierDeliveryEnabled(this.operation(request, businessId), storeId, enabled);
    return null;
  });

  // Zones
  readonly listZones = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { zones: await this.service.listZones(this.operation(request, businessId), schemas.listZonesQuerySchema.parse(request.query).storeId) };
  });
  readonly createZone = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { zone: await this.service.createZone(this.operation(request, businessId), schemas.createZoneSchema.parse(request.body)) };
  }, 201);
  readonly updateZone = this.handle(async (request) => {
    const { businessId, zoneId } = schemas.zoneParamsSchema.parse(request.params);
    return { zone: await this.service.updateZone(this.operation(request, businessId), zoneId, schemas.updateZoneSchema.parse(request.body)) };
  });
  readonly deleteZone = this.handle(async (request) => {
    const { businessId, zoneId } = schemas.zoneParamsSchema.parse(request.params);
    await this.service.deleteZone(this.operation(request, businessId), zoneId);
    return null;
  });
  readonly matchZone = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { storeId, locationId, zipCode } = schemas.matchZoneQuerySchema.parse(request.query);
    const match = await this.service.matchZone(this.operation(request, businessId), storeId, locationId, zipCode);
    return { match: match ?? null };
  });

  // Carrier rates and shipments
  readonly getRates = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return this.service.getRates(this.operation(request, businessId), schemas.getRatesSchema.parse(request.body));
  });
  readonly createShipment = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { delivery: await this.service.createShipment(this.operation(request, businessId), schemas.createShipmentSchema.parse(request.body)) };
  }, 201);
  readonly listDeliveriesForOrder = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { orderId } = schemas.listDeliveriesQuerySchema.parse(request.query);
    return { deliveries: await this.service.listDeliveriesForOrder(this.operation(request, businessId), orderId) };
  });
  readonly refreshTracking = this.handle(async (request) => {
    const { businessId, deliveryId } = schemas.deliveryParamsSchema.parse(request.params);
    return { delivery: await this.service.refreshTracking(this.operation(request, businessId), deliveryId) };
  });

  private operation(request: Request, businessId: string): DeliveryOperation {
    return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
