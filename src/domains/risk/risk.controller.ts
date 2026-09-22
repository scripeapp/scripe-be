import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./risk.schemas.js";
import type { RiskService } from "./risk.service.js";
import type { RiskOperation } from "./risk.types.js";

export class RiskController {
  constructor(private readonly service: RiskService) {}

  readonly listSignals = this.handle((request) => this.service.listSignals(this.operation(request), schemas.listSignalsQuerySchema.parse(request.query)));
  readonly getStats = this.handle(async (request) => ({ stats: await this.service.getStats(this.operation(request)) }));
  readonly reviewSignal = this.handle(async (request) => {
    const { signalId } = schemas.signalParamsSchema.parse(request.params);
    return { signal: await this.service.reviewSignal(this.operation(request), signalId, schemas.reviewSignalSchema.parse(request.body)) };
  });

  readonly listCases = this.handle(async (request) => ({ cases: await this.service.listCases(this.operation(request), schemas.listCasesQuerySchema.parse(request.query).status) }));
  readonly getCase = this.handle((request) => {
    const { caseId } = schemas.caseParamsSchema.parse(request.params);
    return this.service.getCase(this.operation(request), caseId);
  });
  readonly createCase = this.handle(async (request) => ({
    case: await this.service.createCase(this.operation(request), schemas.createCaseSchema.parse(request.body)),
  }), 201);
  readonly updateCase = this.handle(async (request) => {
    const { caseId } = schemas.caseParamsSchema.parse(request.params);
    return { case: await this.service.updateCase(this.operation(request), caseId, schemas.updateCaseSchema.parse(request.body)) };
  });

  readonly listHolds = this.handle(async (request) => ({ holds: await this.service.listHolds(this.operation(request), schemas.listHoldsQuerySchema.parse(request.query).status) }));
  readonly createHold = this.handle(async (request) => ({
    hold: await this.service.createHold(this.operation(request), schemas.createHoldSchema.parse(request.body)),
  }), 201);
  readonly releaseHold = this.handle(async (request) => {
    const { holdId } = schemas.holdParamsSchema.parse(request.params);
    return { hold: await this.service.releaseHold(this.operation(request), holdId) };
  });

  private operation(request: Request): RiskOperation {
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
