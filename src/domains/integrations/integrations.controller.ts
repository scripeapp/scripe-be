import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { updateGoogleCalendarSchema } from "./integrations.schemas.js";
import type { IntegrationsService } from "./integrations.service.js";
import type { IntegrationsOperation } from "./integrations.types.js";

export class IntegrationsController {
  constructor(private readonly service: IntegrationsService) {}

  readonly list = this.handle(async (request) => ({
    googleCalendar: await this.service.googleCalendarStatus(this.operation(request)),
  }));

  readonly updateGoogleCalendar = this.handle(async (request) => ({
    googleCalendar: await this.service.setMeetEnabled(this.operation(request), updateGoogleCalendarSchema.parse(request.body).meetEnabled),
  }));

  readonly disconnectGoogleCalendar = this.handle(async (request) => ({
    googleCalendar: await this.service.disconnectGoogleCalendar(this.operation(request)),
  }));

  private operation(request: Request): IntegrationsOperation {
    return { userId: requireAuthContext(request).userId, requestId: request.requestId };
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
