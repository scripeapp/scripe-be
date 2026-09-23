import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { balanceQuerySchema, businessParamsSchema, countParamsSchema, countsQuerySchema, createCountSchema, createTransferSchema, inventoryItemSchema, inventoryLocationSchema, itemParamsSchema, itemsQuerySchema, movementSchema, movementsQuerySchema, receiveTransferSchema, reservationParamsSchema, reservationSchema, setCountLinesSchema, transferParamsSchema, transfersQuerySchema } from "./inventory.schemas.js";
import type { InventoryService } from "./inventory.service.js";
import type { InventoryOperation } from "./inventory.types.js";
export class InventoryController {
  constructor(private readonly service: InventoryService) {}
  readonly balances = this.handle(async (r) => { const p = balanceQuerySchema.parse({ ...r.params, ...r.query }); return { balances: await this.service.listBalances(this.operation(r, p.businessId), p) }; });
  readonly listItems = this.handle(async (r) => { const p = itemsQuerySchema.parse({ ...r.params, ...r.query }); return { items: await this.service.listItems(this.operation(r, p.businessId), p) }; });
  readonly getItem = this.handle(async (r) => { const p = itemParamsSchema.parse(r.params); return { item: await this.service.getItem(this.operation(r, p.businessId), p.itemId) }; });
  readonly listLocations = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { locations: await this.service.listLocations(this.operation(r, p.businessId)) }; });
  readonly listMovements = this.handle(async (r) => { const p = movementsQuerySchema.parse({ ...r.params, ...r.query }); return { movements: await this.service.listMovements(this.operation(r, p.businessId), p) }; });
  readonly createItem = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { item: await this.service.createItem(this.operation(r, p.businessId), inventoryItemSchema.parse(r.body)) }; }, 201);
  readonly createLocation = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { location: await this.service.createLocation(this.operation(r, p.businessId), inventoryLocationSchema.parse(r.body)) }; }, 201);
  readonly movement = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { movement: await this.service.postMovement(this.operation(r, p.businessId), movementSchema.parse(r.body)) }; }, 201);
  readonly reserve = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { reservation: await this.service.reserve(this.operation(r, p.businessId), reservationSchema.parse(r.body)) }; }, 201);
  readonly release = this.handle(async (r) => { const p = reservationParamsSchema.parse(r.params); return { reservation: await this.service.release(this.operation(r, p.businessId), p.reservationId) }; });

  readonly listTransfers = this.handle(async (r) => { const p = transfersQuerySchema.parse({ ...r.params, ...r.query }); return { transfers: await this.service.listTransfers(this.operation(r, p.businessId), p) }; });
  readonly getTransfer = this.handle(async (r) => { const p = transferParamsSchema.parse(r.params); return { transfer: await this.service.getTransfer(this.operation(r, p.businessId), p.transferId) }; });
  readonly createTransfer = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { transfer: await this.service.createTransfer(this.operation(r, p.businessId), createTransferSchema.parse(r.body)) }; }, 201);
  readonly sendTransfer = this.handle(async (r) => { const p = transferParamsSchema.parse(r.params); return { transfer: await this.service.sendTransfer(this.operation(r, p.businessId), p.transferId) }; });
  readonly receiveTransfer = this.handle(async (r) => { const p = transferParamsSchema.parse(r.params); return { transfer: await this.service.receiveTransfer(this.operation(r, p.businessId), p.transferId, receiveTransferSchema.parse(r.body)) }; });
  readonly cancelTransfer = this.handle(async (r) => { const p = transferParamsSchema.parse(r.params); await this.service.cancelTransfer(this.operation(r, p.businessId), p.transferId); return { cancelled: true }; });

  readonly listCounts = this.handle(async (r) => { const p = countsQuerySchema.parse({ ...r.params, ...r.query }); return { counts: await this.service.listCounts(this.operation(r, p.businessId), p) }; });
  readonly getCount = this.handle(async (r) => { const p = countParamsSchema.parse(r.params); return { count: await this.service.getCount(this.operation(r, p.businessId), p.countId) }; });
  readonly createCount = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { count: await this.service.createCount(this.operation(r, p.businessId), createCountSchema.parse(r.body)) }; }, 201);
  readonly setCountLines = this.handle(async (r) => { const p = countParamsSchema.parse(r.params); return { lines: await this.service.setCountLines(this.operation(r, p.businessId), p.countId, setCountLinesSchema.parse(r.body)) }; });
  readonly applyCount = this.handle(async (r) => { const p = countParamsSchema.parse(r.params); return { count: await this.service.applyCount(this.operation(r, p.businessId), p.countId) }; });
  readonly cancelCount = this.handle(async (r) => { const p = countParamsSchema.parse(r.params); await this.service.cancelCount(this.operation(r, p.businessId), p.countId); return { cancelled: true }; });

  private operation(r: Request, businessId: string): InventoryOperation { return { userId: requireAuthContext(r).userId, businessId, requestId: r.requestId }; }
  private handle<T>(work: (r: Request) => Promise<T>, status = 200) { return async (r: Request, res: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(res, await work(r), status); } catch (e) { next(e); } }; }
}
