import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./promotions.schemas.js";
import type { PromotionsService } from "./promotions.service.js";
import type { PromotionsOperation } from "./promotions.types.js";

export class PromotionsController {
  constructor(private readonly service: PromotionsService) {}

  readonly list = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { discounts: await this.service.list(this.operation(request, businessId)) };
  });

  readonly get = this.handle(async (request) => {
    const { businessId, discountId } = schemas.discountParamsSchema.parse(request.params);
    return { discount: await this.service.get(this.operation(request, businessId), discountId) };
  });

  readonly create = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { discount: await this.service.create(this.operation(request, businessId), schemas.createDiscountSchema.parse(request.body)) };
  }, 201);

  readonly update = this.handle(async (request) => {
    const { businessId, discountId } = schemas.discountParamsSchema.parse(request.params);
    return { discount: await this.service.update(this.operation(request, businessId), discountId, schemas.updateDiscountSchema.parse(request.body)) };
  });

  readonly archive = this.handle(async (request) => {
    const { businessId, discountId } = schemas.discountParamsSchema.parse(request.params);
    await this.service.archive(this.operation(request, businessId), discountId);
    return { archived: true };
  });

  readonly evaluate = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { evaluation: await this.service.evaluate(this.operation(request, businessId), schemas.evaluateSchema.parse(request.body)) };
  });

  private operation(request: Request, businessId: string): PromotionsOperation {
    return {
      userId: requireAuthContext(request).userId,
      businessId,
      requestId: request.requestId,
    };
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
