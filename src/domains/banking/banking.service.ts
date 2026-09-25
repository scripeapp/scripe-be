import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { paymentProvider, type BusinessDocument } from "../../integrations/payment-provider.js";
import { objectStorage } from "../../integrations/r2.js";
import { emailSender } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import { AppError, conflictError, forbiddenError, notFoundError, rateLimitedError, validationError } from "../../shared/errors.js";
import { maskIdentifier } from "../../shared/pii-crypto.js";
import type { ApprovalsService } from "../approvals/approvals.service.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as businessesRepository from "../businesses/businesses.repository.js";
import * as complianceRepository from "../compliance/compliance.repository.js";
import { requirePlatformAdministrator } from "../platform/platform.service.js";
import { hasActiveHold, recordSignal } from "../risk/risk.service.js";
import * as repository from "./banking.repository.js";
import { settlementNameMatches } from "./banking.name-match.js";
import type {
  BankingOperation,
  BankingProfileRow,
  BankingStatus,
  FinalizeWithdrawalInput,
  KybReviewDocument,
  KybReviewStatus,
  KybReviewSummary,
  ListWalletTransactionsFilter,
  PlatformBankingOperation,
  ProviderCustomerType,
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
/** Every submission costs a provider identity lookup — capped per business so a failing BVN can't be retried (or brute-forced) indefinitely. */
const KYC_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_KYC_ATTEMPTS_PER_WINDOW = 5;
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
        customerType: profile?.providerCustomerType ?? null,
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
    const profile = await this.beginSubmission(operation, "individual");
    const customerCode = await this.ensureProviderCustomer(operation, profile, "individual", false, () =>
      paymentProvider.createCustomer({ email: input.email, firstName: input.firstName, lastName: input.lastName, phone: input.phone }),
    );

    const status = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
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
      await repository.saveIndividualSubmission(context, operation.businessId, {
        kycStatus: validation.status,
        notificationEmail: operation.userEmail,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        bvn: input.bvn,
        settlementBankCode: input.bankCode,
        settlementAccountNumber: input.accountNumber,
      });
      await this.logAction(context, operation, "banking.kyc_submitted", "banking_profile", operation.businessId, { status: validation.status, type: "individual" });
      return validation.status;
    });

    const name = `${input.firstName} ${input.lastName}`;
    this.notify("KYC submitted", () => emailSender.sendBankingKybSubmitted(operation.userEmail, { businessName: name, directorName: input.firstName, dashboardUrl: dashboardUrl() }));
    if (status === "verified") {
      this.notify("KYC approved", () => emailSender.sendBankingKybApproved(operation.userEmail, { businessName: name, directorName: input.firstName, dashboardUrl: dashboardUrl() }));
    }
    return { status };
  }

  /**
   * Corporate KYB. Nothing here can mark a business verified: with Anchor
   * the decision arrives via customer.identification.* webhooks after
   * Anchor's own CAC/document review; with Brails (which only validates the
   * director's BVN) a platform administrator decides via reviewKyb().
   */
  async submitKyb(operation: BankingOperation, input: SubmitKybInput): Promise<{ status: "pending" }> {
    const profile = await this.beginSubmission(operation, "business", (context) => this.requireKybUploads(context, operation.businessId, input));

    // The settlement account must belong to the business being verified —
    // resolved by the provider, never taken from the client.
    const resolved = await paymentProvider.resolveBankAccount(input.settlementAccountNumber, input.settlementBankCode);
    const acceptedNames = input.businessType === "sole_proprietorship" ? [input.registeredBusinessName, input.directorFullName] : [input.registeredBusinessName];
    if (!acceptedNames.some((name) => settlementNameMatches(name, resolved.accountName))) {
      throw validationError(
        `The settlement account is registered to "${resolved.accountName}", which doesn't match ${input.businessType === "sole_proprietorship" ? "the business or director name" : "the registered business name"}. Use an account held in the business's name.`,
      );
    }

    const [firstName, ...rest] = input.directorFullName.trim().split(/\s+/);
    const lastName = rest.pop()!;
    const middleName = rest.length > 0 ? rest.join(" ") : null;
    const address = {
      addressLine1: input.address.streetAddress,
      addressLine2: input.address.apartment ?? null,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
      country: input.address.countryCode,
    };

    // A provider customer is only reused when it was created for this same
    // business identity — a changed name, CAC number or director gets a new
    // customer rather than verifying new details against a stale record.
    const sameIdentity =
      profile?.registeredBusinessName === input.registeredBusinessName && profile?.registrationNumber === input.registrationNumber && profile?.bvn === input.directorBvn;
    const customerCode = await this.ensureProviderCustomer(operation, profile, "business", !sameIdentity, () =>
      paymentProvider.createBusinessCustomer({
        businessName: input.registeredBusinessName,
        registrationType: input.businessType,
        registrationNumber: input.registrationNumber,
        taxIdentificationNumber: input.taxIdentificationNumber ?? null,
        dateOfRegistration: input.dateOfRegistration,
        industry: input.businessCategory,
        description: input.description ?? null,
        website: input.website ?? null,
        email: input.directorEmail,
        phone: input.directorPhone,
        address,
        director: {
          firstName: firstName!,
          lastName,
          middleName,
          email: input.directorEmail,
          phone: input.directorPhone,
          bvn: input.directorBvn,
          dateOfBirth: input.directorDob,
          nationality: "NG",
          address,
        },
      }),
    );

    const storedFiles = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      await this.syncComplianceRecords(context, operation, input);
      await paymentProvider.submitBusinessVerification({ customerCode });
      await repository.saveBusinessSubmission(context, operation.businessId, {
        notificationEmail: operation.userEmail,
        email: input.directorEmail,
        firstName: firstName!,
        lastName,
        phone: input.directorPhone,
        bvn: input.directorBvn,
        businessType: input.businessType,
        registeredBusinessName: input.registeredBusinessName,
        registrationNumber: input.registrationNumber,
        taxIdentificationNumber: input.taxIdentificationNumber ?? null,
        dateOfRegistration: input.dateOfRegistration,
        website: input.website ?? null,
        description: input.description ?? null,
        businessCategory: input.businessCategory,
        annualRevenue: input.annualRevenue ?? null,
        businessAddress: input.address,
        directorNin: input.directorNin ?? null,
        directorDob: input.directorDob,
        directorIdType: input.directorIdType,
        directorIdNumber: input.directorIdNumber,
        directorIdDocumentUploadId: input.directorIdDocumentUploadId,
        certificateOfIncorporationUploadId: input.certificateOfIncorporationUploadId,
        statusReportUploadId: input.statusReportUploadId ?? null,
        proofOfAddressUploadId: input.proofOfAddressUploadId,
        settlementBankCode: input.settlementBankCode,
        settlementAccountNumber: input.settlementAccountNumber,
        settlementAccountName: resolved.accountName,
      });
      await this.logAction(context, operation, "banking.kyc_submitted", "banking_profile", operation.businessId, {
        status: "pending",
        type: "corporate",
        reviewer: paymentProvider.verifiesBusinesses ? paymentProvider.name : "platform",
      });
      return repository.findUploads(context, kybUploadIds(input));
    });

    this.notify("KYB submitted", () =>
      emailSender.sendBankingKybSubmitted(operation.userEmail, { businessName: input.registeredBusinessName, directorName: firstName!, dashboardUrl: dashboardUrl() }),
    );
    // Anchor may already be asking for documents; anything it asks for later
    // arrives as customer.identification.awaitingDocument and is handled by
    // provider-events.
    if (paymentProvider.verifiesBusinesses) {
      void this.submitStoredKybDocuments(customerCode, input, storedFiles).catch((error) => console.warn("KYB document upload deferred to webhook:", error));
    }
    return { status: "pending" };
  }

  async requestVirtualAccount(operation: BankingOperation, input: RequestVirtualAccountInput): Promise<VirtualAccountRow> {
    const created = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      const profile = await repository.findProfile(context, operation.businessId);
      if (!profile || profile.kycStatus === "not_started" || profile.kycStatus === "failed") {
        throw forbiddenError("Complete banking KYC before requesting a virtual account");
      }
      const isBusiness = profile.providerCustomerType === "business";
      // Individuals may proceed while "pending" — Brails validates the BVN
      // as part of account creation and Anchor refuses unverified customers.
      // A business account is never opened before its KYB is approved.
      if (isBusiness && profile.kycStatus !== "verified") {
        throw forbiddenError("Your business verification is still under review");
      }

      const existing = await repository.findCurrentVirtualAccount(context, operation.businessId);
      if (existing) return { account: existing, isNew: false, profile };
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
        accountType: isBusiness ? "CORPORATE" : "INDIVIDUAL",
        businessName: isBusiness ? profile.registeredBusinessName ?? undefined : undefined,
        rcNumber: isBusiness ? profile.registrationNumber ?? undefined : undefined,
        tin: isBusiness ? profile.taxIdentificationNumber ?? undefined : undefined,
      });

      // The name comes from the provider/bank only — never from what the
      // business typed in, so an account can't be labelled as someone else.
      const row = await repository.createVirtualAccount(context, operation.businessId, {
        providerCustomerCode: profile.providerCustomerCode,
        providerAccountId: account.providerAccountId,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        bankName: account.bankName,
        bankSlug: account.bankSlug,
        status: account.status,
        assignmentReference: account.assignmentReference,
        metadata: { ...account },
      });

      if (account.status === "active") await repository.markIndividualProfileVerified(context, operation.businessId);
      await this.logAction(context, operation, "banking.virtual_account_requested", "virtual_account", row.id, {});
      return { account: row, isNew: true, profile };
    });

    const { account, isNew, profile } = created;
    if (isNew && profile.notificationEmail && account.accountNumber && account.bankName) {
      const displayName = account.accountName ?? profile.registeredBusinessName ?? "your business";
      this.notify("virtual account issued", () =>
        emailSender.sendVirtualAccountIssued(profile.notificationEmail!, {
          businessName: displayName,
          accountNumber: account.accountNumber!,
          accountName: displayName,
          bankName: account.bankName!,
          dashboardUrl: dashboardUrl(),
        }),
      );
    }
    return account;
  }

  async requeryVirtualAccount(operation: BankingOperation): Promise<VirtualAccountRow> {
    const outcome = await this.run(operation, async (context) => {
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
      const updated = (await repository.updateVirtualAccount(context, account.id, { status: refreshed.status, lastRequeryAt: new Date() }))!;
      const becameActive = refreshed.status === "active" && account.status !== "active";
      if (refreshed.status === "active") await repository.markIndividualProfileVerified(context, operation.businessId);
      const profile = becameActive ? await repository.findProfile(context, operation.businessId) : undefined;
      return { updated, becameActive, profile };
    });

    const { updated, becameActive, profile } = outcome;
    if (becameActive && profile?.notificationEmail && updated.accountNumber && updated.bankName) {
      const displayName = updated.accountName ?? profile.registeredBusinessName ?? "your business";
      this.notify("virtual account issued", () =>
        emailSender.sendVirtualAccountIssued(profile.notificationEmail!, {
          businessName: displayName,
          accountNumber: updated.accountNumber!,
          accountName: displayName,
          bankName: updated.bankName!,
          dashboardUrl: dashboardUrl(),
        }),
      );
    }
    return updated;
  }

  // ==========================================================================
  // Platform KYB review (Brails has no provider-side KYB)
  // ==========================================================================

  async listKybReviews(operation: PlatformBankingOperation, filter: { status: KybReviewStatus; limit: number; offset: number }): Promise<{ reviews: KybReviewSummary[]; totalCount: number }> {
    return this.runAsPlatform(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "moderator");
      const { profiles, totalCount } = await repository.listProfilesForReview(context, filter);
      return { reviews: await Promise.all(profiles.map((profile) => this.toReviewSummary(context, profile, false))), totalCount };
    });
  }

  async getKybReview(operation: PlatformBankingOperation, businessId: string): Promise<KybReviewSummary> {
    return this.runAsPlatform(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "moderator");
      const profile = await repository.findProfile(context, businessId);
      if (!profile || profile.providerCustomerType !== "business") throw notFoundError("No business verification found");
      return this.toReviewSummary(context, profile, true);
    });
  }

  async reviewKyb(operation: PlatformBankingOperation, businessId: string, input: { decision: "approve" | "reject"; notes?: string }): Promise<KybReviewSummary> {
    const reviewed = await this.runAsPlatform(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "finance");
      if (input.decision === "approve" && paymentProvider.verifiesBusinesses) {
        throw conflictError(`${paymentProvider.name} performs KYB itself — approval arrives from the provider, not a manual review`);
      }
      const decided = await repository.decideBusinessReview(context, businessId, {
        status: input.decision === "approve" ? "verified" : "failed",
        reviewedBy: operation.userId,
        notes: input.notes ?? null,
      });
      if (!decided) throw conflictError("This business verification is no longer pending review");
      await auditRepository.log(context, {
        businessId,
        actorUserId: operation.userId,
        action: input.decision === "approve" ? "banking.kyb_approved" : "banking.kyb_rejected",
        targetType: "banking_profile",
        targetId: businessId,
        metadata: { notes: input.notes ?? null },
        requestId: operation.requestId,
      });
      return decided;
    });

    if (reviewed.notificationEmail) {
      const params = { businessName: reviewed.registeredBusinessName ?? "your business", directorName: reviewed.firstName ?? "there" };
      if (input.decision === "approve") {
        this.notify("KYB approved", () => emailSender.sendBankingKybApproved(reviewed.notificationEmail!, { ...params, dashboardUrl: dashboardUrl() }));
      } else {
        this.notify("KYB rejected", () => emailSender.sendBankingKybFailed(reviewed.notificationEmail!, { ...params, reason: input.notes ?? "", retryUrl: dashboardUrl() }));
      }
    }
    return this.getKybReview(operation, businessId);
  }

  /**
   * Permission, state and rate-limit checks, committed in their own
   * transaction so the attempt still counts when a later provider call
   * fails. `validate` runs before the attempt is recorded — a malformed
   * submission shouldn't burn one of the business's attempts.
   */
  private async beginSubmission(
    operation: BankingOperation,
    kind: ProviderCustomerType,
    validate?: (context: DatabaseContext) => Promise<void>,
  ): Promise<BankingProfileRow | undefined> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      // KYB writes the business's legal profile and director records.
      if (kind === "business") await requirePermission(context, operation.businessId, "compliance.manage");
      if (!operation.userEmailVerified) throw forbiddenError("Verify your account email before submitting banking verification");

      const profile = await repository.findProfile(context, operation.businessId);
      if (profile?.kycStatus === "verified") throw conflictError("Banking KYC is already verified");
      if (profile?.kycStatus === "pending") throw conflictError("Banking KYC is already pending review");

      await validate?.(context);

      const attempts = await repository.countKycAttemptsSince(context, operation.businessId, new Date(Date.now() - KYC_ATTEMPT_WINDOW_MS));
      if (attempts >= MAX_KYC_ATTEMPTS_PER_WINDOW) {
        throw rateLimitedError("Too many verification attempts for this business. Try again in 24 hours or contact support.");
      }
      await repository.recordKycAttempt(context, operation.businessId, operation.userId, kind);
      return profile;
    });
  }

  /** Reuses the stored provider customer when it is the right type (and, for KYB, the same identity); otherwise creates one and commits its code immediately. */
  private async ensureProviderCustomer(
    operation: BankingOperation,
    profile: BankingProfileRow | undefined,
    type: ProviderCustomerType,
    forceNew: boolean,
    create: () => Promise<{ customerCode: string }>,
  ): Promise<string> {
    if (!forceNew && profile?.providerCustomerCode && profile.providerCustomerType === type) return profile.providerCustomerCode;
    const { customerCode } = await create();
    await this.run(operation, (context) =>
      repository.saveProviderCustomer(context, operation.businessId, { providerCustomerCode: customerCode, providerCustomerType: type, notificationEmail: operation.userEmail }),
    );
    return customerCode;
  }

  /** Every document must be a confirmed compliance upload belonging to this business, and no file may stand in for two documents. */
  private async requireKybUploads(context: DatabaseContext, businessId: string, input: SubmitKybInput): Promise<void> {
    const ids = kybUploadIds(input);
    if (new Set(ids).size !== ids.length) throw validationError("Each document must be a separate upload");
    const uploads = await repository.findUploads(context, ids);
    for (const id of ids) {
      const upload = uploads.find((candidate) => candidate.id === id);
      if (!upload || upload.businessId !== businessId) throw validationError("A document upload was not found for this business");
      if (upload.purpose !== "compliance_document") throw validationError("Documents must be uploaded as compliance documents");
      if (upload.status !== "confirmed") throw validationError("A document upload has not finished — upload it again");
    }
  }

  /**
   * Mirrors the submission into the compliance domain. Runs inside the
   * submission's transaction with no try/catch: in Postgres a failed
   * statement aborts the whole transaction, so swallowing an error here
   * would only resurface as a confusing failure on the next write.
   */
  private async syncComplianceRecords(context: DatabaseContext, operation: BankingOperation, input: SubmitKybInput): Promise<void> {
    await complianceRepository.upsertLegalProfile(context, operation.businessId, operation.userId, {
      registeredName: input.registeredBusinessName,
      registrationNumber: input.registrationNumber,
      taxIdentificationNumber: input.taxIdentificationNumber ?? null,
      countryCode: input.address.countryCode,
      addressLine1: input.address.streetAddress,
      addressLine2: input.address.apartment ?? null,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
    });
    const owners = await complianceRepository.listBeneficialOwners(context, operation.businessId);
    const alreadyRecorded = owners.some((owner) => owner.relationship === "director" && owner.idType === input.directorIdType && owner.idNumber === input.directorIdNumber);
    if (!alreadyRecorded) {
      await complianceRepository.createBeneficialOwner(context, operation.businessId, operation.userId, {
        fullName: input.directorFullName,
        relationship: "director",
        // Ownership isn't collected by the KYB form; a director isn't
        // assumed to own the business.
        ownershipPercentageBps: null,
        idType: input.directorIdType,
        idNumber: input.directorIdNumber,
        nationality: "NG",
      });
    }
  }

  private async submitStoredKybDocuments(customerCode: string, input: SubmitKybInput, uploads: readonly repository.KybUploadRow[]): Promise<void> {
    const file = (uploadId: string | undefined, kind: BusinessDocument["kind"]): BusinessDocument | null => {
      const upload = uploads.find((candidate) => candidate.id === uploadId);
      if (!upload) return null;
      return { kind, file: { mimeType: upload.mimeType, fileName: upload.objectKey.split("/").pop() ?? kind, load: () => objectStorage.getObjectBytes(upload.objectKey) } };
    };
    const documents = [
      file(input.certificateOfIncorporationUploadId, "certificate_of_incorporation"),
      file(input.statusReportUploadId, "status_report"),
      file(input.proofOfAddressUploadId, "proof_of_address"),
      file(input.directorIdDocumentUploadId, "director_id"),
      { kind: "registration_number" as const, text: input.registrationNumber },
      input.taxIdentificationNumber ? { kind: "tax_identification_number" as const, text: input.taxIdentificationNumber } : null,
    ].filter((document): document is BusinessDocument => document !== null);
    await paymentProvider.submitBusinessDocuments({ customerCode, documents });
  }

  private async toReviewSummary(context: DatabaseContext, profile: BankingProfileRow, withDownloadUrls: boolean): Promise<KybReviewSummary> {
    const slots: [KybReviewDocument["kind"], string | null][] = [
      ["certificate_of_incorporation", profile.certificateOfIncorporationUploadId],
      ["status_report", profile.statusReportUploadId],
      ["proof_of_address", profile.proofOfAddressUploadId],
      ["director_id", profile.directorIdDocumentUploadId],
    ];
    const uploads = await repository.findUploads(context, slots.map(([, id]) => id).filter((id): id is string => !!id));
    const documents: KybReviewDocument[] = [];
    for (const [kind, uploadId] of slots) {
      const upload = uploads.find((candidate) => candidate.id === uploadId);
      if (!upload) continue;
      documents.push({
        kind,
        uploadId: upload.id,
        mimeType: upload.mimeType,
        downloadUrl: withDownloadUrls && upload.status === "confirmed" ? await objectStorage.createPresignedDownloadUrl(upload.objectKey) : null,
      });
    }
    return {
      businessId: profile.businessId,
      kycStatus: profile.kycStatus,
      businessType: profile.businessType,
      registeredBusinessName: profile.registeredBusinessName,
      registrationNumber: profile.registrationNumber,
      taxIdentificationNumber: profile.taxIdentificationNumber,
      dateOfRegistration: profile.dateOfRegistration,
      businessCategory: profile.businessCategory,
      website: profile.website,
      businessAddress: profile.businessAddress,
      directorName: [profile.firstName, profile.lastName].filter(Boolean).join(" "),
      directorEmail: profile.email,
      directorPhone: profile.phone,
      directorBvnMasked: maskIdentifier(profile.bvn),
      directorIdType: profile.directorIdType,
      directorIdNumberMasked: maskIdentifier(profile.directorIdNumber),
      settlementBankCode: profile.settlementBankCode,
      settlementAccountNumber: profile.settlementAccountNumber,
      settlementAccountName: profile.settlementAccountName,
      provider: paymentProvider.name,
      kycSubmittedAt: profile.kycSubmittedAt?.toISOString() ?? null,
      kybReviewedAt: profile.kybReviewedAt?.toISOString() ?? null,
      kybReviewNotes: profile.kybReviewNotes,
      documents,
    };
  }

  /** Emails are sent after the transaction commits — never for a submission that then rolled back. */
  private notify(label: string, send: () => Promise<void>): void {
    void send().catch((error) => console.warn(`Failed to dispatch ${label} email:`, error));
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
  async finalizeGatedWithdrawal(operation: BankingPrincipal, withdrawalId: string, outcome: "approved" | "rejected"): Promise<void> {
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

  private async logAction(context: DatabaseContext, operation: BankingPrincipal, action: string, targetType: string, targetId: string, metadata: Record<string, unknown>): Promise<void> {
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

  private async runAsPlatform<T>(operation: PlatformBankingOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }

  private async run<T>(operation: BankingPrincipal, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

/** What a transaction needs — callers like approvals finalize withdrawals without a user session's email. */
type BankingPrincipal = Pick<BankingOperation, "userId" | "businessId" | "requestId">;

function dashboardUrl(): string {
  return `${loadEnvironment().FRONTEND_URL}/dashboard/banking`;
}

function kybUploadIds(input: SubmitKybInput): string[] {
  return [input.certificateOfIncorporationUploadId, input.proofOfAddressUploadId, input.directorIdDocumentUploadId, input.statusReportUploadId].filter(
    (id): id is string => !!id,
  );
}
