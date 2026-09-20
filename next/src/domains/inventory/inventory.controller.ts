import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { balanceQuerySchema, businessParamsSchema, inventoryItemSchema, inventoryLocationSchema, movementSchema, reservationParamsSchema, reservationSchema } from "./inventory.schemas.js";
import type { InventoryService } from "./inventory.service.js";
import type { InventoryOperation } from "./inventory.types.js";
export class InventoryController {
  constructor(private readonly service: InventoryService) {}
  readonly balances = this.handle(async (r) => { const p = balanceQuerySchema.parse({ ...r.params, ...r.query }); return { balances: await this.service.listBalances(this.operation(r, p.businessId), p) }; });
  readonly createItem = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { item: await this.service.createItem(this.operation(r, p.businessId), inventoryItemSchema.parse(r.body)) }; }, 201);
  readonly createLocation = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { location: await this.service.createLocation(this.operation(r, p.businessId), inventoryLocationSchema.parse(r.body)) }; }, 201);
  readonly movement = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { movement: await this.service.postMovement(this.operation(r, p.businessId), movementSchema.parse(r.body)) }; }, 201);
  readonly reserve = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { reservation: await this.service.reserve(this.operation(r, p.businessId), reservationSchema.parse(r.body)) }; }, 201);
  readonly release = this.handle(async (r) => { const p = reservationParamsSchema.parse(r.params); return { reservation: await this.service.release(this.operation(r, p.businessId), p.reservationId) }; });
  private operation(r: Request, businessId: string): InventoryOperation { return { userId: requireAuthContext(r).userId, businessId, requestId: r.requestId }; }
  private handle<T>(work: (r: Request) => Promise<T>, status = 200) { return async (r: Request, res: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(res, await work(r), status); } catch (e) { next(e); } }; }
}
