import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { updatePreferencesSchema } from "./preferences.schemas.js";
import type { PreferencesService } from "./preferences.service.js";
import type { PreferencesOperation } from "./preferences.types.js";

export class PreferencesController {
  constructor(private readonly service: PreferencesService) {}

  readonly get = this.handle(async (request) => ({
    preferences: await this.service.get(this.operation(request)),
  }));

  readonly update = this.handle(async (request) => ({
    preferences: await this.service.update(this.operation(request), updatePreferencesSchema.parse(request.body)),
  }));

  private operation(request: Request): PreferencesOperation {
    return {
      userId: requireAuthContext(request).userId,
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
