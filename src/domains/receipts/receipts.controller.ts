import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./receipts.schemas.js";
import type { ReceiptsService } from "./receipts.service.js";
import type { ReceiptsOperation } from "./receipts.types.js";

export class ReceiptsController {
  constructor(private readonly service: ReceiptsService) {}

  readonly list = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { receipts: await this.service.list(this.operation(request, businessId)) };
  });

  readonly getForOrder = this.handle(async (request) => {
    const { businessId, orderId } = schemas.orderParamsSchema.parse(request.params);
    return { receipt: await this.service.getForOrder(this.operation(request, businessId), orderId) };
  });

  readonly get = this.handle(async (request) => {
    const { businessId, documentId } = schemas.documentParamsSchema.parse(request.params);
    return { receipt: await this.service.get(this.operation(request, businessId), documentId) };
  });

  private operation(request: Request, businessId: string): ReceiptsOperation {
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
