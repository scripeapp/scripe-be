import type { NextFunction, Request, Response } from "express";
import { z } from "zod";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { SchedulingService } from "./scheduling.service.js";

const idParams = z.object({ id: z.string().uuid() });
const uuid = z.string().uuid();

function requireBusinessId(request: Request): string {
  const fromQuery = typeof request.query.business_id === "string" ? request.query.business_id : undefined;
  const fromBody = request.body && typeof request.body.business_id === "string" ? request.body.business_id : undefined;
  const parsed = uuid.safeParse(fromQuery ?? fromBody);
  if (!parsed.success) {
    throw Object.assign(new Error("business_id is required"), { statusCode: 400, code: "VALIDATION_ERROR" });
  }
  return parsed.data;
}

export class SchedulingController {
  constructor(private readonly service: SchedulingService) {}

  // ── availability ───────────────────────────────────────────────────────────

  readonly listAvailability = this.handle(async (request) =>
    this.service.listAvailability(this.userId(request), request.requestId, requireBusinessId(request)),
  );

  readonly createAvailability = this.handle(async (request) =>
    this.service.createAvailability(this.userId(request), request.requestId, requireBusinessId(request), request.body ?? {}),
    201,
  );

  readonly updateAvailability = this.handle(async (request) =>
    this.service.updateAvailability(this.userId(request), request.requestId, idParams.parse(request.params).id, request.body ?? {}),
  );

  readonly deleteAvailability = this.handle(async (request) => {
    await this.service.deleteAvailability(this.userId(request), request.requestId, idParams.parse(request.params).id);
    return { deleted: true };
  });

  readonly duplicateAvailability = this.handle(async (request) =>
    this.service.duplicateAvailability(this.userId(request), request.requestId, idParams.parse(request.params).id),
    201,
  );

  // ── event types ──────────────────────────────────────────────────────────────

  readonly listEventTypes = this.handle(async (request) =>
    this.service.listEventTypes(this.userId(request), request.requestId, requireBusinessId(request)),
  );

  // Event-type appointments. Persistence is not wired yet (the storefront
  // scheduling-checkout is a later step), so this returns an empty list rather
  // than 404 — the Bookings screen renders its empty state cleanly.
  readonly listBookings = this.handle(async (request) => {
    requireBusinessId(request);
    return [] as unknown[];
  });

  readonly createEventType = this.handle(async (request) =>
    this.service.createEventType(this.userId(request), request.requestId, requireBusinessId(request), request.body ?? {}),
    201,
  );

  readonly updateEventType = this.handle(async (request) =>
    this.service.updateEventType(this.userId(request), request.requestId, idParams.parse(request.params).id, request.body ?? {}),
  );

  readonly deleteEventType = this.handle(async (request) => {
    await this.service.deleteEventType(this.userId(request), request.requestId, idParams.parse(request.params).id);
    return { deleted: true };
  });

  private userId(request: Request): string {
    return requireAuthContext(request).userId;
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
