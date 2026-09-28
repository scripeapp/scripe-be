import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  serviceSettingsParamsSchema,
  upsertServiceSettingsSchema,
} from "./service-settings.schemas.js";
import type { ServiceSettingsService } from "./service-settings.service.js";
import type { ServiceSettingsOperation } from "./service-settings.types.js";

export class ServiceSettingsController {
  constructor(private readonly service: ServiceSettingsService) {}

  readonly get = this.handle(async (request) => {
    const { productId } = serviceSettingsParamsSchema.parse(request.params);
    return { serviceSettings: await this.service.get(this.operation(request), productId) };
  });

  readonly upsert = this.handle(async (request) => {
    const { productId } = serviceSettingsParamsSchema.parse(request.params);
    const input = upsertServiceSettingsSchema.parse(request.body);
    return { serviceSettings: await this.service.upsert(this.operation(request), productId, input) };
  });

  private operation(request: Request): ServiceSettingsOperation {
    const { businessId } = serviceSettingsParamsSchema.parse(request.params);
    return { userId: requireAuthContext(request).userId, requestId: request.requestId, businessId };
  }

  private handle<T>(work: (request: Request) => Promise<T>) {
    return async (request: Request, response: Response, next: NextFunction): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request));
      } catch (error) {
        next(error);
      }
    };
  }
}
