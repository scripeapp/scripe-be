import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { paymentProvider } from "../../integrations/payment-provider.js";
import { AppError, conflictError, forbiddenError, notFoundError, validationError } from "../../shared/errors.js";
import type { ApprovalsService } from "../approvals/approvals.service.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as businessesRepository from "../businesses/businesses.repository.js";
import { hasActiveHold, recordSignal } from "../risk/risk.service.js";
import * as complianceRepository from "../compliance/compliance.repository.js";
import * as repository from "./banking.repository.js";
import { emailSender } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import type {
  BankingOperation,
  BankingStatus,
  FinalizeWithdrawalInput,
  ListWalletTransactionsFilter,
  RequestVirtualAccountInput,
  RequestWithdrawalInput,
  ResolveBankAccountInput,
  SubmitKycInput,
  SubmitKybInput,
  VirtualAccountRow,
  WalletTransactionRow,
  WithdrawalRow,
} from "./banking.types.js";

const REQUERY_COOLDOWN_MS = 10 * 60 * 1000;
const ASSET_CODE = "NGN";
/** Ported from legacy fraud-detection.service.ts's runChecks() thresholds (₦500k/₦2m) - real rule values that existed in legacy but were never actually wired to any request path. This is that wiring. */
const LARGE_WITHDRAWAL_HIGH_MINOR = 500_000_00n;
const LARGE_WITHDRAWAL_CRITICAL_MINOR = 2_000_000_00n;

export class BankingService {
  constructor(
    private readonly database: Database,
    private readonly approvals: ApprovalsService,
  ) {}

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

      const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
      if (input.email) {
        void emailSender.sendBankingKybSubmitted?.(input.email, {
          businessName: `${input.firstName} ${input.lastName}`,
          directorName: input.firstName,
          dashboardUrl: `${frontendUrl}/dashboard/banking`,
        })?.catch?.((err) => console.warn("Failed to dispatch KYC submitted email:", err));

        if (validation.status === "verified") {
          void emailSender.sendBankingKybApproved?.(input.email, {
            businessName: `${input.firstName} ${input.lastName}`,
            directorName: input.firstName,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          })?.catch?.((err) => console.warn("Failed to dispatch KYC approved email:", err));
        }
      }

      return { status: validation.status };
    });
  }

  async submitKyb(operation: BankingOperation, input: SubmitKybInput): Promise<{ status: "verified" | "pending" }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const profile = await repository.findProfile(context, operation.businessId);
      if (profile?.kycStatus === "verified") throw conflictError("Banking KYC is already verified");
      if (profile?.kycStatus === "pending") throw conflictError("Banking KYC is already pending review");

      const nameParts = input.directorFullName.trim().split(/\s+/);
      const firstName = nameParts[0] || "Director";
      const lastName = nameParts.slice(1).join(" ") || "Signatory";

      const customerCode = profile?.providerCustomerCode ?? (await paymentProvider.createCustomer({
        email: input.directorEmail,
        firstName,
        lastName,
        phone: input.directorPhone,
        businessName: input.registeredBusinessName,
        rcNumber: input.registrationNumber,
        businessType: input.businessType,
      })).customerCode;

      const validation = await paymentProvider.validateCustomerBvn({
        customerCode,
        firstName,
        lastName,
        bvn: input.directorBvn,
        bankCode: input.settlementBankCode,
        accountNumber: input.settlementAccountNumber,
        dateOfBirth: input.directorDob,
        gender: input.directorGender,
      });

      // Synchronize legal profile and beneficial owner into compliance domain
      if (input.registrationNumber) {
        try {
          await complianceRepository.upsertLegalProfile(context, operation.businessId, operation.userId, {
            registeredName: input.registeredBusinessName,
            registrationNumber: input.registrationNumber,
            taxIdentificationNumber: input.taxIdentificationNumber ?? null,
            countryCode: input.address.countryCode ?? "NG",
            addressLine1: input.address.streetAddress,
            addressLine2: input.address.apartment ?? null,
            city: input.address.city,
            state: input.address.state,
            postalCode: input.address.postalCode ?? null,
          });
          await complianceRepository.createBeneficialOwner(context, operation.businessId, operation.userId, {
            fullName: input.directorFullName,
            relationship: "director",
            ownershipPercentageBps: 10000,
            idType: (input.directorIdType as any) || "nin",
            idNumber: input.directorNin || input.directorBvn,
            nationality: "Nigerian",
          });
        } catch (compErr) {
          // Non-fatal if compliance sync encounters permission or duplicate constraint
          console.warn("Compliance sync non-fatal error:", compErr);
        }
      }

      const now = new Date();
      await repository.upsertProfile(context, operation.businessId, {
        kycStatus: validation.status,
        kycFailureReason: null,
        kycSubmittedAt: now,
        kycVerifiedAt: validation.status === "verified" ? now : null,
        providerCustomerCode: customerCode,
        email: input.directorEmail,
        firstName,
        lastName,
        phone: input.directorPhone,
        bvn: input.directorBvn,
        businessType: input.businessType,
        registeredBusinessName: input.registeredBusinessName,
        registrationNumber: input.registrationNumber,
        taxIdentificationNumber: input.taxIdentificationNumber,
        website: input.website,
        description: input.description,
        businessCategory: input.businessCategory,
        annualRevenue: input.annualRevenue,
        businessAddress: input.address,
        directorNin: input.directorNin,
        directorDob: input.directorDob,
        directorIdType: input.directorIdType,
        directorIdDocumentUrl: input.directorIdDocumentUrl,
        certificateOfIncorporationUrl: input.certificateOfIncorporationUrl,
        statusReportUrl: input.statusReportUrl,
        proofOfAddressUrl: input.proofOfAddressUrl,
        settlementBankCode: input.settlementBankCode,
        settlementAccountNumber: input.settlementAccountNumber,
        settlementAccountName: input.settlementAccountName,
      });

      await this.logAction(context, operation, "banking.kyc_submitted", "banking_profile", operation.businessId, { status: validation.status, type: "corporate" });

      const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
      if (input.directorEmail) {
        void emailSender.sendBankingKybSubmitted?.(input.directorEmail, {
          businessName: input.registeredBusinessName || "your business",
          directorName: firstName,
          dashboardUrl: `${frontendUrl}/dashboard/banking`,
        })?.catch?.((err) => console.warn("Failed to dispatch KYB submitted email:", err));

        if (validation.status === "verified") {
          void emailSender.sendBankingKybApproved?.(input.directorEmail, {
            businessName: input.registeredBusinessName || "your business",
            directorName: firstName,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          })?.catch?.((err) => console.warn("Failed to dispatch KYB approved email:", err));
        }
      }

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

      const isCorporate = !!profile.registeredBusinessName || profile.businessType === "limited_liability" || profile.businessType === "sole_proprietorship";
      const account = await paymentProvider.createDedicatedAccount({
        customerCode: profile.providerCustomerCode,
        email: profile.email,
        firstName: profile.firstName,
        lastName: profile.lastName,
        phone: profile.phone,
        preferredBank: input.preferredBank,
        bvn: profile.bvn ?? undefined,
        accountType: isCorporate ? "CORPORATE" : "INDIVIDUAL",
        businessName: profile.registeredBusinessName ?? undefined,
        rcNumber: profile.registrationNumber ?? undefined,
        tin: profile.taxIdentificationNumber ?? undefined,
      });

      const status = account.status;
      const created = await repository.createVirtualAccount(context, operation.businessId, {
        providerCustomerCode: profile.providerCustomerCode,
        providerAccountId: account.providerAccountId,
        accountNumber: account.accountNumber,
        accountName: account.accountName || profile.registeredBusinessName || `${profile.firstName} ${profile.lastName}`,
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

      if (profile.email && created.accountNumber && created.bankName) {
        const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
        const accountDisplayName = created.accountName || profile.registeredBusinessName || "your business";
        void emailSender.sendVirtualAccountIssued?.(profile.email, {
          businessName: accountDisplayName,
          accountNumber: created.accountNumber,
          accountName: accountDisplayName,
          bankName: created.bankName,
          dashboardUrl: `${frontendUrl}/dashboard/banking`,
        })?.catch?.((err) => console.warn("Failed to dispatch virtual account issued email:", err));
      }

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
        if (account.status !== "active" && profile?.email && (account.accountNumber || updated?.accountNumber) && (account.bankName || updated?.bankName)) {
          const frontendUrl = loadEnvironment().FRONTEND_URL || "https://gosurge.com";
          const accountDisplayName = updated?.accountName || account.accountName || profile.registeredBusinessName || "your business";
          void emailSender.sendVirtualAccountIssued?.(profile.email, {
            businessName: accountDisplayName,
            accountNumber: (updated?.accountNumber || account.accountNumber)!,
            accountName: accountDisplayName,
            bankName: (updated?.bankName || account.bankName)!,
            dashboardUrl: `${frontendUrl}/dashboard/banking`,
          })?.catch?.((err) => console.warn("Failed to dispatch virtual account issued email:", err));
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

      if (await hasActiveHold(context, "business", operation.businessId)) {
        throw forbiddenError("This business's wallet is on hold; contact support before withdrawing.");
      }

      const existing = await repository.findWithdrawalByIdempotencyKey(context, operation.businessId, input.idempotencyKey);
      if (existing) return existing;

      const profile = await repository.findProfile(context, operation.businessId);
      if (profile?.kycStatus !== "verified") throw validationError("Complete banking verification before sending money from your wallet");

      const balance = await repository.getAvailableBalance(context, operation.businessId);
      if (BigInt(input.amountMinor) > BigInt(balance)) throw validationError("Insufficient wallet balance");

      const withdrawalAmount = BigInt(input.amountMinor);
      if (withdrawalAmount >= LARGE_WITHDRAWAL_HIGH_MINOR) {
        await recordSignal(context, {
          entityType: "business",
          entityId: operation.businessId,
          signalType: withdrawalAmount >= LARGE_WITHDRAWAL_CRITICAL_MINOR ? "very_large_withdrawal" : "large_withdrawal",
          description: `Withdrawal of ${input.amountMinor} ${ASSET_CODE} minor units requested`,
          severity: withdrawalAmount >= LARGE_WITHDRAWAL_CRITICAL_MINOR ? "critical" : "high",
          metadata: { amountMinor: input.amountMinor, assetCode: ASSET_CODE, requestedBy: operation.userId },
        });
      }

      const membership = await authorizationRepository.findMembershipByUserId(context, operation.businessId, operation.userId);
      const isOwner = membership?.roles.some((role) => role.code === "owner") ?? false;

      // Gated FIRST, before anything is written — a blocked submission
      // (ineligible submitter, a step with zero eligible approvers) throws
      // with nothing created, so there's nothing to compensate/reverse.
      const withdrawalId = randomUUID();
      const gate = await this.approvals.gateSubmission(context, operation.businessId, "withdrawal", {
        subjectType: "withdrawal",
        subjectId: withdrawalId,
        amountMinor: String(input.amountMinor),
        assetCode: ASSET_CODE,
        requestedBy: operation.userId,
        requestedByEmail: profile.email ?? "",
        requestedByIsOwner: isOwner,
      });

      const reference = `wd_${randomUUID()}`;

      if (gate.gated) {
        // The debit is posted now, at gate time, not deferred until
        // approval — the whole point is closing the double-spend window a
        // pending-for-hours approval would otherwise open: a second
        // concurrent withdrawal request must see this amount already
        // reserved, which the "pending" status already achieves since
        // getAvailableBalance sums pending+posted.
        const withdrawal = await repository.createWithdrawal(context, operation.businessId, operation.userId, {
          id: withdrawalId,
          amountMinor: String(input.amountMinor),
          assetCode: ASSET_CODE,
          bankCode: input.bankCode,
          accountNumber: input.accountNumber,
          accountName: input.accountName,
          providerReference: reference,
          idempotencyKey: input.idempotencyKey,
          status: "awaitingApproval",
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
          metadata: { withdrawalId: withdrawal.id, approvalRequestId: gate.requestId },
        });
        await this.logAction(context, operation, "banking.withdrawal_awaiting_approval", "withdrawal", withdrawal.id, { amountMinor: input.amountMinor, approvalRequestId: gate.requestId });
        return withdrawal;
      }

      const withdrawal = await repository.createWithdrawal(context, operation.businessId, operation.userId, {
        id: withdrawalId,
        amountMinor: String(input.amountMinor),
        assetCode: ASSET_CODE,
        bankCode: input.bankCode,
        accountNumber: input.accountNumber,
        accountName: input.accountName,
        providerReference: reference,
        idempotencyKey: input.idempotencyKey,
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

      const finalized = await this.callProviderAndFinalize(context, operation.businessId, withdrawal.id, reference, input.accountName, input.accountNumber, input.bankCode, String(input.amountMinor), profile.email);
      await this.logAction(context, operation, "banking.withdrawal_requested", "withdrawal", withdrawal.id, { amountMinor: input.amountMinor });
      return finalized;
    });
  }

  /**
   * Called once a gated withdrawal's approval_requests row reaches a
   * terminal state — see approvals.controller.ts, which dispatches here
   * after ApprovalsService.decideApproval() returns (kept out of
   * approvals.service.ts itself to avoid a circular import: banking needs
   * to call approvals to gate, approvals would need to call banking to
   * finalize).
   */
  async finalizeGatedWithdrawal(operation: BankingOperation, withdrawalId: string, outcome: "approved" | "rejected"): Promise<void> {
    return this.run(operation, async (context) => {
      const withdrawal = await repository.findWithdrawalById(context, operation.businessId, withdrawalId);
      if (!withdrawal) throw notFoundError("Withdrawal not found");

      if (outcome === "rejected") {
        if (withdrawal.status !== "awaitingApproval") return; // already resolved by a prior call
        await repository.updateWithdrawal(context, withdrawal.id, { status: "rejected", failureReason: "Rejected by approver" });
        await repository.postWalletTransaction(context, operation.businessId, {
          type: "reversal",
          direction: "credit",
          status: "posted",
          assetCode: withdrawal.assetCode,
          amountMinor: withdrawal.amountMinor,
          provider: paymentProvider.name,
          providerReference: `${withdrawal.providerReference}:reversal`,
          description: "Withdrawal reversal — rejected by approver",
          metadata: { withdrawalId: withdrawal.id },
        });
        await this.logAction(context, operation, "banking.withdrawal_rejected", "withdrawal", withdrawal.id, {});
        return;
      }

      // Conditional claim — re-entrancy safety independent of the approval
      // engine's own version CAS, in case this is ever invoked more than
      // once for the same withdrawal.
      const claimed = await repository.claimWithdrawalForProcessing(context, withdrawal.id);
      if (!claimed) return;

      const profile = await repository.findProfile(context, operation.businessId);
      await this.callProviderAndFinalize(context, operation.businessId, withdrawal.id, withdrawal.providerReference, withdrawal.accountName, withdrawal.accountNumber, withdrawal.bankCode, withdrawal.amountMinor, profile?.email ?? null);
      await this.logAction(context, operation, "banking.withdrawal_approved", "withdrawal", withdrawal.id, {});
    });
  }

  private async callProviderAndFinalize(
    context: DatabaseContext,
    businessId: string,
    withdrawalId: string,
    reference: string,
    accountName: string,
    accountNumber: string,
    bankCode: string,
    amountMinor: string,
    customerEmail: string | null,
  ): Promise<WithdrawalRow> {
    const virtualAccount = await repository.findCurrentVirtualAccount(context, businessId);
    // Some providers (e.g. Brails) require the sender's registered
    // business address as compliance data when adding a payout
    // beneficiary — resolved here rather than assumed present.
    const business = await businessesRepository.findBusiness(context, businessId);
    const sender =
      business?.addressLine1 && business.city && business.postalCode
        ? { businessName: business.displayName, addressLine1: business.addressLine1, city: business.city, country: business.country, postalCode: business.postalCode }
        : undefined;
    const recipient = await paymentProvider.createTransferRecipient({ name: accountName, accountNumber, bankCode, sender });
    const transfer = await paymentProvider.initiateTransfer({
      amountMinor,
      recipientCode: recipient.recipientCode,
      reference,
      reason: "Wallet withdrawal",
      sourceAccountId: virtualAccount?.providerAccountId,
      customerEmail,
    });
    const finalized = await repository.updateWithdrawal(context, withdrawalId, {
      status: transfer.status,
      transferRecipientCode: recipient.recipientCode,
      providerTransferCode: transfer.transferCode,
    });
    return finalized!;
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
