import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./notifications.schemas.js";
import type { NotificationsService } from "./notifications.service.js";
import type { NotificationsOperation } from "./notifications.types.js";

export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  readonly list = this.handle(async (request) => ({
    notifications: await this.service.list(this.operation(request), schemas.listQuerySchema.parse(request.query)),
  }));

  readonly unreadCount = this.handle(async (request) => ({
    unreadCount: await this.service.unreadCount(this.operation(request)),
  }));

  readonly update = this.handle(async (request) => {
    const { notificationId } = schemas.notificationParamsSchema.parse(request.params);
    return { notification: await this.service.update(this.operation(request), notificationId, schemas.updateNotificationSchema.parse(request.body)) };
  });

  readonly listPreferences = this.handle(async (request) => ({
    preferences: await this.service.listPreferences(this.operation(request)),
  }));

  readonly setPreference = this.handle(async (request) => {
    const { type, channel } = schemas.preferenceParamsSchema.parse(request.params);
    const { enabled } = schemas.setPreferenceSchema.parse(request.body);
    return { preference: await this.service.setPreference(this.operation(request), type, channel, enabled) };
  });

  private operation(request: Request): NotificationsOperation {
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
