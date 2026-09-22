import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  businessIdParamsSchema,
  createBusinessSchema,
  updateBusinessSchema,
} from "./businesses.schemas.js";
import type { BusinessesService } from "./businesses.service.js";
import type { BusinessOperation } from "./businesses.types.js";

export class BusinessesController {
  constructor(private readonly service: BusinessesService) {}

  readonly list = this.handle(async (request) => ({
    businesses: await this.service.list(this.operation(request)),
  }));

  readonly create = this.handle(
    async (request) => ({
      business: await this.service.create(
        this.operation(request),
        createBusinessSchema.parse(request.body),
      ),
    }),
    201,
  );

  readonly get = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    return {
      business: await this.service.get(this.operation(request), businessId),
    };
  });

  readonly update = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    return {
      business: await this.service.update(
        this.operation(request),
        businessId,
        updateBusinessSchema.parse(request.body),
      ),
    };
  });

  readonly archive = this.handle(async (request) => {
    const { businessId } = businessIdParamsSchema.parse(request.params);
    await this.service.archive(this.operation(request), businessId);
    return { archived: true };
  });

  private operation(request: Request): BusinessOperation {
    return {
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (
      request: Request,
      response: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
