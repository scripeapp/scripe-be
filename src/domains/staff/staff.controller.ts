import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  businessParamsSchema,
  commissionReportQuerySchema,
  createExceptionSchema,
  createStaffSchema,
  exceptionParamsSchema,
  listExceptionsQuerySchema,
  setStaffScheduleSchema,
  setStaffServicesSchema,
  staffParamsSchema,
  updateStaffSchema,
} from "./staff.schemas.js";
import type { StaffService } from "./staff.service.js";
import type { StaffOperation } from "./staff.types.js";

export class StaffController {
  constructor(private readonly service: StaffService) {}

  readonly list = this.handle(async (request) => ({
    staff: await this.service.list(this.operation(request)),
  }));

  readonly create = this.handle(async (request) => ({
    staff: await this.service.create(this.operation(request), createStaffSchema.parse(request.body)),
  }), 201);

  readonly update = this.handle(async (request) => ({
    staff: await this.service.update(this.operation(request), staffParamsSchema.parse(request.params).staffId, updateStaffSchema.parse(request.body)),
  }));

  readonly remove = this.handle(async (request) => {
    await this.service.remove(this.operation(request), staffParamsSchema.parse(request.params).staffId);
    return { deleted: true };
  });

  readonly setServices = this.handle(async (request) => ({
    staff: await this.service.setServices(this.operation(request), staffParamsSchema.parse(request.params).staffId, setStaffServicesSchema.parse(request.body)),
  }));

  readonly setSchedule = this.handle(async (request) => ({
    staff: await this.service.setSchedule(this.operation(request), staffParamsSchema.parse(request.params).staffId, setStaffScheduleSchema.parse(request.body)),
  }));

  readonly listExceptions = this.handle(async (request) => ({
    exceptions: await this.service.listExceptions(this.operation(request), listExceptionsQuerySchema.parse(request.query).staffId),
  }));

  readonly createException = this.handle(async (request) => ({
    exception: await this.service.createException(this.operation(request), createExceptionSchema.parse(request.body)),
  }), 201);

  readonly removeException = this.handle(async (request) => {
    await this.service.removeException(this.operation(request), exceptionParamsSchema.parse(request.params).exceptionId);
    return { deleted: true };
  });

  readonly commissionReport = this.handle(async (request) => {
    const { from, to } = commissionReportQuerySchema.parse(request.query);
    return { report: await this.service.commissionReport(this.operation(request), from, to) };
  });

  private operation(request: Request): StaffOperation {
    const { businessId } = businessParamsSchema.parse(request.params);
    return { userId: requireAuthContext(request).userId, requestId: request.requestId, businessId };
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
