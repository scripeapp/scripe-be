import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./jobs.schemas.js";
import type { JobsService } from "./jobs.service.js";
import type { JobsOperation } from "./jobs.types.js";

export class JobsController {
  constructor(private readonly service: JobsService) {}

  readonly listJobs = this.handle((request) => this.service.listJobs(this.operation(request), schemas.listJobsQuerySchema.parse(request.query)));

  readonly getJob = this.handle((request) => {
    const { jobId } = schemas.jobParamsSchema.parse(request.params);
    return this.service.getJob(this.operation(request), jobId);
  });

  readonly rerunJob = this.handle(async (request) => {
    const { jobId } = schemas.jobParamsSchema.parse(request.params);
    return { job: await this.service.rerunJob(this.operation(request), jobId) };
  });

  readonly cancelJob = this.handle(async (request) => {
    const { jobId } = schemas.jobParamsSchema.parse(request.params);
    return { job: await this.service.cancelJob(this.operation(request), jobId) };
  });

  private operation(request: Request): JobsOperation {
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
