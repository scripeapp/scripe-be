import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import type { AccountingService } from "./accounting.service.js";
import * as schemas from "./accounting.schemas.js";
import type { AccountingOperation } from "./accounting.types.js";

export class AccountingController {
  constructor(private readonly service: AccountingService) {}

  readonly listLedgerAccounts = this.handle(async (request) => ({
    accounts: await this.service.listLedgerAccounts(this.operation(request)),
  }));

  readonly listJournalEntries = this.handle(async (request) => ({
    entries: await this.service.listJournalEntries(this.operation(request), schemas.listJournalEntriesQuerySchema.parse(request.query).limit),
  }));

  readonly getJournalEntry = this.handle(async (request) => {
    const { journalEntryId } = schemas.journalEntryParamsSchema.parse(request.params);
    return { entry: await this.service.getJournalEntry(this.operation(request), journalEntryId) };
  });

  readonly getTrialBalance = this.handle(async (request) => ({
    lines: await this.service.getTrialBalance(this.operation(request)),
  }));

  readonly listPeriods = this.handle(async (request) => ({
    periods: await this.service.listPeriods(this.operation(request)),
  }));

  readonly setPeriodStatus = this.handle(async (request) => {
    const { periodId } = schemas.periodParamsSchema.parse(request.params);
    return { period: await this.service.setPeriodStatus(this.operation(request), periodId, schemas.setPeriodStatusSchema.parse(request.body).status) };
  });

  private operation(request: Request): AccountingOperation {
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
