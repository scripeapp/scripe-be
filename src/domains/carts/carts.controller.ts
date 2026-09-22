import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { CartsService } from "./carts.service.js";
import * as schemas from "./carts.schemas.js";
import type { CartOperation } from "./carts.types.js";
export class CartsController {
  constructor(private readonly service: CartsService) {}
  readonly create = this.handle(async (req) => { const p = schemas.params.pick({ businessId: true }).parse(req.params); return { cart: await this.service.create(this.operation(req, p.businessId), schemas.create.parse(req.body)) }; }, 201);
  readonly get = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { cart: await this.service.get(this.operation(req, p.businessId), p.cartId) }; });
  readonly addLine = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { cart: await this.service.addLine(this.operation(req, p.businessId), p.cartId, schemas.addLine.parse(req.body)) }; }, 201);
  readonly updateLine = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { cart: await this.service.updateLine(this.operation(req, p.businessId), p.cartId, p.lineId!, schemas.updateLine.parse(req.body)) }; });
  readonly deleteLine = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { cart: await this.service.deleteLine(this.operation(req, p.businessId), p.cartId, p.lineId!) }; });
  readonly checkout = this.handle(async (req) => { const p = schemas.params.parse(req.params); return { checkout: await this.service.checkout(this.operation(req, p.businessId), p.cartId, schemas.checkout.parse(req.body)) }; }, 201);
  private operation(request: Request, businessId: string): CartOperation { return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId }; }
  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) { return async (request: Request, response: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(response, await work(request), statusCode); } catch (error) { next(error); } }; }
}
