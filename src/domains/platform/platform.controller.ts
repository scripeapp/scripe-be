import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./platform.schemas.js";
import type { PlatformService } from "./platform.service.js";
import type { PlatformOperation } from "./platform.types.js";

export class PlatformController {
  constructor(private readonly service: PlatformService) {}

  readonly listAdministrators = this.handle(async (request) => ({
    administrators: await this.service.listAdministrators(this.operation(request)),
  }));

  readonly createAdministrator = this.handle(async (request) => ({
    administrator: await this.service.createAdministrator(this.operation(request), schemas.createAdministratorSchema.parse(request.body)),
  }), 201);

  readonly updateAdministrator = this.handle(async (request) => {
    const { administratorId } = schemas.administratorParamsSchema.parse(request.params);
    return { administrator: await this.service.updateAdministrator(this.operation(request), administratorId, schemas.updateAdministratorSchema.parse(request.body)) };
  });

  readonly deactivateAdministrator = this.handle(async (request) => {
    const { administratorId } = schemas.administratorParamsSchema.parse(request.params);
    await this.service.deactivateAdministrator(this.operation(request), administratorId);
    return null;
  });

  readonly listAlerts = this.handle(async (request) => this.service.listAlerts(this.operation(request), schemas.listAlertsQuerySchema.parse(request.query)));

  readonly unreadAlertCount = this.handle(async (request) => ({
    count: await this.service.unreadAlertCount(this.operation(request)),
  }));

  readonly markAlertsRead = this.handle(async (request) => {
    const { alertIds } = schemas.markAlertsReadSchema.parse(request.body);
    await this.service.markAlertsRead(this.operation(request), alertIds);
    return null;
  });

  readonly listAnnouncements = this.handle(async (request) => this.service.listAnnouncements(this.operation(request), schemas.listAnnouncementsQuerySchema.parse(request.query)));

  readonly createAnnouncement = this.handle(async (request) => ({
    announcement: await this.service.createAnnouncement(this.operation(request), schemas.createAnnouncementSchema.parse(request.body)),
  }), 201);

  readonly updateAnnouncement = this.handle(async (request) => {
    const { announcementId } = schemas.announcementParamsSchema.parse(request.params);
    return { announcement: await this.service.updateAnnouncement(this.operation(request), announcementId, schemas.updateAnnouncementSchema.parse(request.body)) };
  });

  readonly deleteAnnouncement = this.handle(async (request) => {
    const { announcementId } = schemas.announcementParamsSchema.parse(request.params);
    await this.service.deleteAnnouncement(this.operation(request), announcementId);
    return null;
  });

  private operation(request: Request): PlatformOperation {
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
