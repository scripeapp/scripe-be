import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { paymentProvider } from "../../integrations/payment-provider.js";
import { AppError, conflictError, forbiddenError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as businessesRepository from "../businesses/businesses.repository.js";
import * as repository from "./banking.repository.js";
import type {
  BankingOperation,
  BankingStatus,
  FinalizeWithdrawalInput,
  ListWalletTransactionsFilter,
  RequestVirtualAccountInput,
  RequestWithdrawalInput,
  ResolveBankAccountInput,
  SubmitKycInput,
  VirtualAccountRow,
  WalletTransactionRow,
  WithdrawalRow,
} from "./banking.types.js";

const REQUERY_COOLDOWN_MS = 10 * 60 * 1000;
const ASSET_CODE = "NGN";

export class BankingService {
  constructor(private readonly database: Database) {}

  async getStatus(operation: BankingOperation): Promise<BankingStatus> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.read");
      const [profile, virtualAccount, balance] = await Promise.all([
        repository.findProfile(context, operation.businessId),
        repository.findCurrentVirtualAccount(context, operation.businessId),
        repository.getAvailableBalance(context, operation.businessId),
      ]);
      return {
        kycStatus: profile?.kycStatus ?? "not_started",
        kycFailureReason: profile?.kycFailureReason ?? null,
        virtualAccount: virtualAccount ?? null,
        availableBalanceMinor: balance,
        assetCode: ASSET_CODE,
      };
    });
  }

  async resolveBankAccount(operation: BankingOperation, input: ResolveBankAccountInput) {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.read");
      return paymentProvider.resolveBankAccount(input.accountNumber, input.bankCode);
    });
  }

  async submitKyc(operation: BankingOperation, input: SubmitKycInput): Promise<{ status: "verified" | "pending" }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const profile = await repository.findProfile(context, operation.businessId);
      if (profile?.kycStatus === "verified") throw conflictError("Banking KYC is already verified");
      if (profile?.kycStatus === "pending") throw conflictError("Banking KYC is already pending review");

      const customerCode = profile?.providerCustomerCode ?? (await paymentProvider.createCustomer({ email: input.email, firstName: input.firstName, lastName: input.lastName, phone: input.phone })).customerCode;
      const validation = await paymentProvider.validateCustomerBvn({
        customerCode,
        firstName: input.firstName,
        lastName: input.lastName,
        bvn: input.bvn,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        dateOfBirth: input.dateOfBirth,
        gender: input.gender,
      });

      const now = new Date();
      await repository.upsertProfile(context, operation.businessId, {
        kycStatus: validation.status,
        kycFailureReason: null,
        kycSubmittedAt: now,
        kycVerifiedAt: validation.status === "verified" ? now : null,
        providerCustomerCode: customerCode,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        bvn: input.bvn,
      });

      await this.logAction(context, operation, "banking.kyc_submitted", "banking_profile", operation.businessId, { status: validation.status });
      return { status: validation.status };
    });
  }

  async requestVirtualAccount(operation: BankingOperation, input: RequestVirtualAccountInput): Promise<VirtualAccountRow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const profile = await repository.findProfile(context, operation.businessId);
      // Not every provider can confirm BVN validation synchronously (Anchor
      // resolves it via webhook; Brails validates identity as part of the
      // account-creation call itself), so a "pending" KYC status is allowed
      // through here — the provider's own account-creation call is the real
      // gate, and a still-unverified customer simply gets rejected by it.
      if (!profile || profile.kycStatus === "not_started" || profile.kycStatus === "failed") {
        throw forbiddenError("Complete banking KYC before requesting a virtual account");
      }

      const existing = await repository.findCurrentVirtualAccount(context, operation.businessId);
      if (existing) return existing;
      if (!profile.providerCustomerCode || !profile.email || !profile.firstName || !profile.lastName || !profile.phone) {
        throw conflictError("Banking provider customer is not ready for this business");
      }

      const account = await paymentProvider.createDedicatedAccount({
        customerCode: profile.providerCustomerCode,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        preferredBank: input.preferredBank,
        bvn: profile.bvn ?? undefined,
      });

      const status = account.status;
      const created = await repository.createVirtualAccount(context, operation.businessId, {
        providerCustomerCode: profile.providerCustomerCode,
        providerAccountId: account.providerAccountId,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        bankSlug: account.bankSlug,
        status,
        assignmentReference: account.assignmentReference,
        metadata: { ...account },
      });

      // A successfully issued (active) virtual account is itself proof the
      // provider accepted this customer's identity — close the loop on a
      // KYC status that could only reach "pending" synchronously.
      if (status === "active" && profile.kycStatus !== "verified") {
        await repository.upsertProfile(context, operation.businessId, { kycStatus: "verified", kycVerifiedAt: new Date() });
      }

      await this.logAction(context, operation, "banking.virtual_account_requested", "virtual_account", created.id, {});
      return created;
    });
  }

  async requeryVirtualAccount(operation: BankingOperation): Promise<VirtualAccountRow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const account = await repository.findCurrentVirtualAccount(context, operation.businessId);
      if (!account) throw notFoundError("No virtual account request found");
      // Some providers (e.g. Anchor) issue accounts asynchronously and never
      // return an accountNumber on the initial create call — requery is how
      // that in-flight state gets resolved, so this only needs the
      // provider's own id for the account, not a fully-provisioned number.
      if (!account.providerAccountId) throw conflictError("Virtual account is not ready for requery");

      const lastRequeryAt = account.lastRequeryAt?.getTime() ?? 0;
      if (Date.now() - lastRequeryAt < REQUERY_COOLDOWN_MS) throw conflictError("Try requerying again after 10 minutes");

      const refreshed = await paymentProvider.requeryDedicatedAccount({ accountNumber: account.accountNumber, bankSlug: account.bankSlug, providerAccountId: account.providerAccountId });
      const updated = await repository.updateVirtualAccount(context, account.id, {
        status: refreshed.status,
        lastRequeryAt: new Date(),
      });

      if (refreshed.status === "active") {
        const profile = await repository.findProfile(context, operation.businessId);
        if (profile && profile.kycStatus !== "verified") {
          await repository.upsertProfile(context, operation.businessId, { kycStatus: "verified", kycVerifiedAt: new Date() });
        }
      }

      return updated!;
    });
  }

  async listWalletTransactions(operation: BankingOperation, filter: ListWalletTransactionsFilter): Promise<{ transactions: WalletTransactionRow[]; totalCount: number }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.read");
      return repository.listWalletTransactions(context, operation.businessId, filter);
    });
  }

  async requestWithdrawal(operation: BankingOperation, input: RequestWithdrawalInput): Promise<WithdrawalRow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");

      const existing = await repository.findWithdrawalByIdempotencyKey(context, operation.businessId, input.idempotencyKey);
      if (existing) return existing;

      const profile = await repository.findProfile(context, operation.businessId);
      if (profile?.kycStatus !== "verified") throw validationError("Complete banking verification before sending money from your wallet");

      const balance = await repository.getAvailableBalance(context, operation.businessId);
      if (BigInt(input.amountMinor) > BigInt(balance)) throw validationError("Insufficient wallet balance");

      // Some providers (e.g. Anchor) debit a specific deposit account rather
      // than a platform-wide balance (e.g. Paystack), so the business's own
      // current virtual account has to be resolved and passed through.
      const virtualAccount = await repository.findCurrentVirtualAccount(context, operation.businessId);
      // Some providers (e.g. Brails) require the sender's registered
      // business address as compliance data when adding a payout
      // beneficiary — resolved here rather than assumed present.
      const business = await businessesRepository.findBusiness(context, operation.businessId);
      const sender =
        business?.addressLine1 && business.city && business.postalCode
          ? { businessName: business.displayName, addressLine1: business.addressLine1, city: business.city, country: business.country, postalCode: business.postalCode }
          : undefined;

      const recipient = await paymentProvider.createTransferRecipient({ name: input.accountName, accountNumber: input.accountNumber, bankCode: input.bankCode, sender });
      const reference = `wd_${randomUUID()}`;
      const transfer = await paymentProvider.initiateTransfer({
        amountMinor: String(input.amountMinor),
        recipientCode: recipient.recipientCode,
        reference,
        reason: "Wallet withdrawal",
        sourceAccountId: virtualAccount?.providerAccountId,
        customerEmail: profile.email,
      });

      const withdrawal = await repository.createWithdrawal(context, operation.businessId, operation.userId, {
        amountMinor: String(input.amountMinor),
        assetCode: ASSET_CODE,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        providerReference: reference,
        idempotencyKey: input.idempotencyKey,
      });
      const finalized = await repository.updateWithdrawal(context, withdrawal.id, {
        status: transfer.status,
        transferRecipientCode: recipient.recipientCode,
        providerTransferCode: transfer.transferCode,
      });

      await repository.postWalletTransaction(context, operation.businessId, {
        type: "withdrawal",
        direction: "debit",
        status: "pending",
        assetCode: ASSET_CODE,
        amountMinor: String(input.amountMinor),
        provider: paymentProvider.name,
        providerReference: reference,
        description: "Wallet withdrawal",
        metadata: { withdrawalId: withdrawal.id },
      });

      await this.logAction(context, operation, "banking.withdrawal_requested", "withdrawal", withdrawal.id, { amountMinor: input.amountMinor });
      return finalized!;
    });
  }

  async finalizeWithdrawal(operation: BankingOperation, input: FinalizeWithdrawalInput): Promise<WithdrawalRow> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const withdrawal = await repository.findWithdrawalByTransferCode(context, operation.businessId, input.transferCode);
      if (!withdrawal) throw notFoundError("Withdrawal not found");

      const transfer = await paymentProvider.finalizeTransfer({ transferCode: input.transferCode, otp: input.otp });
      const updated = await repository.updateWithdrawal(context, withdrawal.id, { status: transfer.status });

      if (transfer.status === "success") {
        await repository.markWalletTransactionPosted(context, paymentProvider.name, withdrawal.providerReference);
      } else if (transfer.status === "failed") {
        await repository.postWalletTransaction(context, operation.businessId, {
          type: "reversal",
          direction: "credit",
          status: "posted",
          assetCode: withdrawal.assetCode,
          amountMinor: withdrawal.amountMinor,
          provider: paymentProvider.name,
          providerReference: `${withdrawal.providerReference}:reversal`,
          description: "Withdrawal reversal",
          metadata: { withdrawalId: withdrawal.id },
        });
      }

      await this.logAction(context, operation, "banking.withdrawal_finalized", "withdrawal", withdrawal.id, { status: transfer.status });
      return updated!;
    });
  }

  private async logAction(context: DatabaseContext, operation: BankingOperation, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
    await auditRepository.log(context, {
      businessId: operation.businessId,
      actorUserId: operation.userId,
      action,
      targetType,
      targetId,
      metadata,
      requestId: operation.requestId,
    });
  }

  private async run<T>(operation: BankingOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
