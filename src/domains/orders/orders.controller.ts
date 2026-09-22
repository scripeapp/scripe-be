import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { OrdersService } from "./orders.service.js";
import * as schemas from "./orders.schemas.js";
import type { OrderOperation } from "./orders.types.js";
export class OrdersController {
  constructor(private readonly service: OrdersService) {}
  readonly list = this.handle(async (req) => { const p = schemas.params.pick({ businessId: true }).parse(req.params); const q = schemas.listQuery.parse(req.query); return { orders: await this.service.list(this.operation(req, p.businessId), q.status, q.limit) }; });
  readonly get = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { order: await this.service.get(this.operation(req, p.businessId), p.orderId) }; });
  private operation(request: Request, businessId: string): OrderOperation { return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId }; }
  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) { return async (request: Request, response: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(response, await work(request), statusCode); } catch (error) { next(error); } }; }
}
