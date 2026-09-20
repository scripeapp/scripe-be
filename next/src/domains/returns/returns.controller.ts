import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./returns.schemas.js";
import type { ReturnsService } from "./returns.service.js";
import type { ReturnsOperation } from "./returns.types.js";

export class ReturnsController {
  constructor(private readonly service: ReturnsService) {}

  readonly list = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const { orderId } = schemas.listQuerySchema.parse(request.query);
    return { returns: await this.service.list(this.operation(request, businessId), orderId) };
  });

  readonly get = this.handle(async (request) => {
    const { businessId, returnId } = schemas.returnParamsSchema.parse(request.params);
    return { return: await this.service.get(this.operation(request, businessId), returnId) };
  });

  readonly create = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { return: await this.service.create(this.operation(request, businessId), schemas.createReturnSchema.parse(request.body)) };
  }, 201);

  private operation(request: Request, businessId: string): ReturnsOperation {
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
