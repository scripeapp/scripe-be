import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  businessParamsSchema,
  listOrdersQuery,
  listReceiptsQuery,
  orderParamsSchema,
  purchaseOrderSchema,
  receiptSchema,
  updateOrderSchema,
} from "./procurement.schemas.js";
import type { ProcurementService } from "./procurement.service.js";

export class ProcurementController {
  constructor(private readonly service: ProcurementService) {}

  readonly listOrders = this.handle(async (r) => {
    const p = businessParamsSchema.parse(r.params);
    const q = listOrdersQuery.parse(r.query);
    const result = await this.service.listOrders(this.op(r, p.businessId), q);
    return { ...result, page: q.page, pageSize: q.pageSize };
  });

  readonly getOrder = this.handle(async (r) => {
    const p = orderParamsSchema.parse(r.params);
    return await this.service.getOrder(this.op(r, p.businessId), p.orderId);
  });

  readonly createOrder = this.handle(async (r) => {
    const p = businessParamsSchema.parse(r.params);
    return { purchaseOrder: await this.service.createOrder(this.op(r, p.businessId), purchaseOrderSchema.parse(r.body)) };
  }, 201);

  readonly updateOrder = this.handle(async (r) => {
    const p = orderParamsSchema.parse(r.params);
    return { purchaseOrder: await this.service.updateOrder(this.op(r, p.businessId), p.orderId, updateOrderSchema.parse(r.body)) };
  });

  readonly sendOrder = this.handle(async (r) => {
    const p = orderParamsSchema.parse(r.params);
    return await this.service.sendOrder(this.op(r, p.businessId), p.orderId);
  });

  readonly receive = this.handle(async (r) => {
    const p = businessParamsSchema.parse(r.params);
    return { receipt: await this.service.receive(this.op(r, p.businessId), receiptSchema.parse(r.body)) };
  }, 201);

  readonly listReceipts = this.handle(async (r) => {
    const p = businessParamsSchema.parse(r.params);
    const q = listReceiptsQuery.parse(r.query);
    const result = await this.service.listReceipts(this.op(r, p.businessId), q);
    return { ...result, page: q.page, pageSize: q.pageSize };
  });

  private op(r: Request, businessId: string) {
    return { userId: requireAuthContext(r).userId, businessId, requestId: r.requestId };
  }

  private handle<T>(w: (r: Request) => Promise<T>, status = 200) {
    return async (r: Request, res: Response, next: NextFunction) => {
      try {
        ApiResponse.success(res, await w(r), status);
      } catch (e) {
        next(e);
      }
    };
  }
}
