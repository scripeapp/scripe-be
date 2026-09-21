import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./banking.schemas.js";
import type { BankingService } from "./banking.service.js";
import type { BankingOperation } from "./banking.types.js";

export class BankingController {
  constructor(private readonly service: BankingService) {}

  readonly getStatus = this.handle(async (request) => ({
    status: await this.service.getStatus(this.operation(request)),
  }));

  readonly resolveBankAccount = this.handle(async (request) => ({
    account: await this.service.resolveBankAccount(this.operation(request), schemas.resolveBankAccountQuerySchema.parse(request.query)),
  }));

  readonly submitKyc = this.handle(async (request) => ({
    kyc: await this.service.submitKyc(this.operation(request), schemas.submitKycSchema.parse(request.body)),
  }));

  readonly requestVirtualAccount = this.handle(
    async (request) => ({ virtualAccount: await this.service.requestVirtualAccount(this.operation(request), schemas.requestVirtualAccountSchema.parse(request.body)) }),
    201,
  );

  readonly requeryVirtualAccount = this.handle(async (request) => ({
    virtualAccount: await this.service.requeryVirtualAccount(this.operation(request)),
  }));

  readonly listWalletTransactions = this.handle(async (request) => {
    const result = await this.service.listWalletTransactions(this.operation(request), schemas.listWalletTransactionsQuerySchema.parse(request.query));
    return { transactions: result.transactions, totalCount: result.totalCount };
  });

  readonly requestWithdrawal = this.handle(
    async (request) => ({ withdrawal: await this.service.requestWithdrawal(this.operation(request), schemas.requestWithdrawalSchema.parse(request.body)) }),
    201,
  );

  readonly finalizeWithdrawal = this.handle(async (request) => ({
    withdrawal: await this.service.finalizeWithdrawal(this.operation(request), schemas.finalizeWithdrawalSchema.parse(request.body)),
  }));

  private operation(request: Request): BankingOperation {
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
