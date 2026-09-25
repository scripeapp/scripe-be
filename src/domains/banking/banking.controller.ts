import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./banking.schemas.js";
import type { BankingService } from "./banking.service.js";
import type { BankingOperation, PlatformBankingOperation } from "./banking.types.js";

export const NIGERIAN_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "023", name: "Citibank Nigeria" },
  { code: "050", name: "Ecobank Nigeria" },
  { code: "070", name: "Fidelity Bank" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "214", name: "First City Monument Bank" },
  { code: "058", name: "Guaranty Trust Bank" },
  { code: "030", name: "Heritage Bank" },
  { code: "082", name: "Keystone Bank" },
  { code: "50211", name: "Kuda Bank" },
  { code: "50515", name: "Moniepoint MFB" },
  { code: "999992", name: "OPay" },
  { code: "999991", name: "PalmPay" },
  { code: "076", name: "Polaris Bank" },
  { code: "101", name: "Providus Bank" },
  { code: "221", name: "Stanbic IBTC Bank" },
  { code: "068", name: "Standard Chartered Bank" },
  { code: "232", name: "Sterling Bank" },
  { code: "100", name: "Suntrust Bank" },
  { code: "032", name: "Union Bank of Nigeria" },
  { code: "033", name: "United Bank for Africa" },
  { code: "215", name: "Unity Bank" },
  { code: "035", name: "Wema Bank" },
  { code: "057", name: "Zenith Bank" },
];

export class BankingController {
  constructor(private readonly service: BankingService) {}

  readonly listBanks = this.handle(async () => NIGERIAN_BANKS);

  readonly getStatus = this.handle(async (request) => ({
    status: await this.service.getStatus(this.operation(request)),
  }));

  readonly getSubaccount = this.handle(async (request) => {
    const status = await this.service.getStatus(this.operation(request));
    if (!status.virtualAccount) {
      return null;
    }
    return {
      subaccount_code: status.virtualAccount.providerAccountId || "",
      business_name: status.virtualAccount.accountName || "",
      settlement_bank: status.virtualAccount.bankName || "",
      account_number: status.virtualAccount.accountNumber || "",
    };
  });

  readonly resolveBankAccount = this.handle(async (request) => ({
    account: await this.service.resolveBankAccount(this.operation(request), schemas.resolveBankAccountQuerySchema.parse(request.query)),
  }));

  readonly submitKyc = this.handle(async (request) => {
    const isCorporate = !!(
      request.body?.registeredBusinessName ||
      request.body?.registered_business_name ||
      request.body?.businessType ||
      request.body?.business_type ||
      request.body?.directorFullName ||
      request.body?.director_full_name ||
      request.body?.registrationNumber ||
      request.body?.rcNumber
    );
    if (isCorporate) {
      return { kyc: await this.service.submitKyb(this.operation(request), schemas.submitKybSchema.parse(request.body)) };
    }
    return { kyc: await this.service.submitKyc(this.operation(request), schemas.submitKycSchema.parse(request.body)) };
  });

  readonly submitKyb = this.handle(async (request) => ({
    kyc: await this.service.submitKyb(this.operation(request), schemas.submitKybSchema.parse(request.body)),
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

  readonly listKybReviews = this.handle(async (request) => this.service.listKybReviews(this.platformOperation(request), schemas.listKybReviewsQuerySchema.parse(request.query)));

  readonly getKybReview = this.handle(async (request) => ({
    review: await this.service.getKybReview(this.platformOperation(request), schemas.reviewKybParamsSchema.parse(request.params).businessId),
  }));

  readonly reviewKyb = this.handle(async (request) => ({
    review: await this.service.reviewKyb(
      this.platformOperation(request),
      schemas.reviewKybParamsSchema.parse(request.params).businessId,
      schemas.reviewKybSchema.parse(request.body),
    ),
  }));

  private platformOperation(request: Request): PlatformBankingOperation {
    return { userId: requireAuthContext(request).userId, requestId: request.requestId };
  }

  private operation(request: Request): BankingOperation {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    const auth = requireAuthContext(request);
    return {
      userId: auth.userId,
      businessId,
      requestId: request.requestId,
      userEmail: auth.email,
      userEmailVerified: auth.emailVerified,
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
