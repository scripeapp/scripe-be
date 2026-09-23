import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./audit.schemas.js";
import type { AuditService } from "./audit.service.js";
import type { AuditOperation } from "./audit.types.js";

export class AuditController {
  constructor(private readonly service: AuditService) {}

  readonly list = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return { events: await this.service.list(this.operation(request, businessId), schemas.listQuerySchema.parse(request.query)) };
  });

  readonly listPlatformAudit = this.handle(async (request) => {
    const userId = requireAuthContext(request).userId;
    const filter = schemas.listQuerySchema.parse(request.query);
    const events = await this.service.listAll(userId, request.requestId, filter);
    return { events, logs: events };
  });

  private operation(request: Request, businessId: string): AuditOperation {
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
