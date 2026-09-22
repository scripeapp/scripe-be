import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./payroll.schemas.js";
import type { PayrollService } from "./payroll.service.js";
import type { PayrollOperation } from "./payroll.types.js";

export class PayrollController {
  constructor(private readonly service: PayrollService) {}

  readonly createRun = this.handle(async (request) => {
    const body = schemas.createRunSchema.parse(request.body);
    return {
      run: await this.service.createRun(this.operation(request), {
        periodStart: body.periodStart,
        periodEnd: body.periodEnd,
        items: body.items.map((item) => ({
          beneficiaryId: item.beneficiaryId,
          partyId: item.partyId,
          grossMinor: BigInt(item.grossMinor),
          deductionsMinor: BigInt(item.deductionsMinor),
        })),
      }),
    };
  }, 201);

  readonly listRuns = this.handle(async (request) => {
    const { status, limit } = schemas.listRunsQuerySchema.parse(request.query);
    return { runs: await this.service.listRuns(this.operation(request), status, limit) };
  });

  readonly getRun = this.handle(async (request) => {
    const { runId } = schemas.runParamsSchema.parse(request.params);
    return { run: await this.service.getRun(this.operation(request), runId) };
  });

  readonly approveRun = this.handle(async (request) => {
    const { runId } = schemas.runParamsSchema.parse(request.params);
    return { run: await this.service.approveRun(this.operation(request), runId) };
  });

  readonly payRun = this.handle(async (request) => {
    const { runId } = schemas.runParamsSchema.parse(request.params);
    return { run: await this.service.payRun(this.operation(request), runId) };
  });

  readonly cancelRun = this.handle(async (request) => {
    const { runId } = schemas.runParamsSchema.parse(request.params);
    return { run: await this.service.cancelRun(this.operation(request), runId) };
  });

  private operation(request: Request): PayrollOperation {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
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
