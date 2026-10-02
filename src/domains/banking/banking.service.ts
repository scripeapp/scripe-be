import { randomUUID } from "node:crypto";
import { getCheckoutSettlementStatus, resolveCheckoutSubaccount, type CheckoutSettlementStatus } from "./checkout-subaccounts.js";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { paymentProvider, type BusinessDocument, type BusinessPersonInput, type KybAddress, KYB_OFFICER_TITLES, type KybOfficerTitle } from "../../integrations/payment-provider.js";
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
import type {
  BankingOperation,
  BankingProfileRow,
  BankingStatus,
  FinalizeWithdrawalInput,
  KybReviewDocument,
  KybReviewStatus,
  KybReviewSummary,
  ListWalletTransactionsFilter,
  ListWithdrawalsFilter,
  PlatformBankingOperation,
  ProviderCustomerType,
  RequestVirtualAccountInput,
  RequestWithdrawalInput,
  ResolveBankAccountInput,
  SubmitKycInput,
  SubmitKybInput,
  VirtualAccountRow,
  WalletTransactionRow,
  WithdrawalBillLink,
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

function formatNaira(minor: string): string {
  return `₦${(Number(minor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

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

  /**
   * Where this business's online sales settle: its active virtual account,
   * via a Paystack subaccount. `setup` creates the subaccount now instead of
   * at the first checkout, so the payout screen can confirm it works.
   */
  async getCheckoutSettlement(operation: BankingOperation, setup = false): Promise<CheckoutSettlementStatus> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, setup ? "banking.manage" : "banking.read");
      if (setup) await resolveCheckoutSubaccount(context, operation.businessId);
      return getCheckoutSettlementStatus(context, operation.businessId);
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

    const primary = primaryDirector(input);
    const address: KybAddress = {
      addressLine1: input.address.streetAddress,
      addressLine2: input.address.apartment ?? null,
      city: input.address.city,
      state: input.address.state,
      postalCode: input.address.postalCode,
      country: input.address.countryCode,
    };
    const registeredAddress: KybAddress = input.registeredAddress
      ? {
          addressLine1: input.registeredAddress.streetAddress,
          addressLine2: input.registeredAddress.apartment ?? null,
          city: input.registeredAddress.city,
          state: input.registeredAddress.state,
          postalCode: input.registeredAddress.postalCode,
          country: input.registeredAddress.countryCode ?? "NG",
        }
      : address;

    const people: BusinessPersonInput[] = input.directors.map((director) => {
      const directorAddress: KybAddress = director.residentialAddress
        ? {
            addressLine1: director.residentialAddress.streetAddress,
            addressLine2: director.residentialAddress.apartment ?? null,
            city: director.residentialAddress.city,
            state: director.residentialAddress.state,
            postalCode: director.residentialAddress.postalCode,
            country: director.residentialAddress.countryCode ?? "NG",
          }
        : address;

      const title: KybOfficerTitle =
        director.title && (KYB_OFFICER_TITLES as readonly string[]).includes(director.title)
          ? (director.title as KybOfficerTitle)
          : director.isPrimary
            ? "CEO"
            : "Manager";

      return {
        role: director.role,
        ownershipPercent: director.ownershipPercent,
        title,
        isPrimary: director.isPrimary,
        firstName: director.firstName,
        lastName: director.lastName,
        middleName: director.middleName,
        email: director.email,
        phone: director.phone,
        bvn: director.bvn,
        dateOfBirth: director.dateOfBirth,
        nationality: director.nationality || "NG",
        address: directorAddress,
        idType: director.idType,
        idNumber: director.idNumber,
      };
    });

    // A provider customer is only reused when it was created for this same
    // business identity — a changed name, CAC number or primary director
    // gets a new customer rather than verifying against a stale record.
    const sameIdentity =
      profile?.registeredBusinessName === input.registeredBusinessName && profile?.registrationNumber === input.registrationNumber && profile?.bvn === primary.bvn;
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
        email: input.businessEmail || primary.email,
        phone: input.businessPhone || primary.phone,
        address,
        registeredAddress,
        people,
      }),
      { registeredBusinessName: input.registeredBusinessName, registrationNumber: input.registrationNumber, bvn: primary.bvn },
    );

    const storedFiles = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.manage");
      await this.syncComplianceRecords(context, operation, input);
      await paymentProvider.submitBusinessVerification({ customerCode });
      await repository.saveBusinessSubmission(context, operation.businessId, {
        notificationEmail: operation.userEmail,
        email: primary.email,
        firstName: primary.firstName,
        lastName: primary.lastName,
        phone: primary.phone,
        bvn: primary.bvn,
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
        businessEmail: input.businessEmail ?? null,
        businessPhone: input.businessPhone ?? null,
        registeredAddress: input.registeredAddress ?? null,
      });
      await repository.replaceKybDirectors(
        context,
        operation.businessId,
        input.directors.map((director) => ({
          isPrimary: director.isPrimary,
          fullName: director.fullName,
          firstName: director.firstName,
          middleName: director.middleName,
          lastName: director.lastName,
          email: director.email,
          phone: director.phone,
          bvn: director.bvn,
          dateOfBirth: director.dateOfBirth,
          idType: director.idType,
          idNumber: director.idNumber,
          idDocumentUploadId: director.idDocumentUploadId,
          role: director.role,
          ownershipPercent: String(director.ownershipPercent),
          title: director.title ?? null,
          nationality: director.nationality || "NG",
          residentialAddress: director.residentialAddress ?? null,
        })),
      );
      const kybDocs: { documentType: string; uploadId: string }[] = [
        { documentType: "CERTIFICATE_OF_INCORPORATION", uploadId: input.certificateOfIncorporationUploadId },
        { documentType: "PROOF_OF_ADDRESS", uploadId: input.proofOfAddressUploadId },
      ];
      if (input.statusReportUploadId) {
        kybDocs.push({ documentType: "CAC_STATUS_REPORT", uploadId: input.statusReportUploadId });
        kybDocs.push({ documentType: "MEMORANDUM_OF_ASSOCIATION", uploadId: input.statusReportUploadId });
      }
      await repository.replaceKybDocuments(context, operation.businessId, kybDocs);
      await this.logAction(context, operation, "banking.kyc_submitted", "banking_profile", operation.businessId, {
        status: "pending",
        type: "corporate",
        directors: input.directors.length,
        reviewer: paymentProvider.verifiesBusinesses ? paymentProvider.name : "platform",
      });
      return repository.findUploads(context, kybUploadIds(input));
    });

    this.notify("KYB submitted", () =>
      emailSender.sendBankingKybSubmitted(operation.userEmail, { businessName: input.registeredBusinessName, directorName: primary.firstName, dashboardUrl: dashboardUrl() }),
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
        provider: paymentProvider.name,
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
      const updated = (await repository.updateVirtualAccount(context, account.id, {
        status: refreshed.status,
        accountNumber: refreshed.accountNumber,
        accountName: refreshed.accountName,
        bankName: refreshed.bankName,
        bankSlug: refreshed.bankSlug,
        lastRequeryAt: new Date(),
      }))!;
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
    identity?: { registeredBusinessName: string; registrationNumber: string; bvn: string },
  ): Promise<string> {
    if (!forceNew && profile?.providerCustomerCode && profile.providerCustomerType === type) return profile.providerCustomerCode;
    const { customerCode } = await create();
    await this.run(operation, (context) =>
      repository.saveProviderCustomer(context, operation.businessId, { providerCustomerCode: customerCode, providerCustomerType: type, notificationEmail: operation.userEmail, identity }),
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
    for (const director of input.directors) {
      const alreadyRecorded = owners.some((owner) => owner.relationship === "director" && owner.idType === director.idType && owner.idNumber === director.idNumber);
      if (alreadyRecorded) continue;
      await complianceRepository.createBeneficialOwner(context, operation.businessId, operation.userId, {
        fullName: director.fullName,
        relationship: "director",
        // Ownership isn't collected by the KYB form; a director isn't
        // assumed to own the business.
        ownershipPercentageBps: null,
        idType: director.idType,
        idNumber: director.idNumber,
        nationality: "NG",
      });
    }
  }

  private async submitStoredKybDocuments(customerCode: string, input: SubmitKybInput, uploads: readonly repository.KybUploadRow[]): Promise<void> {
    const file = (uploadId: string | undefined, documentType: string): BusinessDocument | null => {
      const upload = uploads.find((candidate) => candidate.id === uploadId);
      if (!upload) return null;
      return {
        documentType,
        file: {
          mimeType: upload.mimeType,
          fileName: upload.objectKey.split("/").pop() ?? documentType,
          load: () => objectStorage.getObjectBytes(upload.objectKey),
        },
      };
    };
    const documents = [
      file(input.certificateOfIncorporationUploadId, "CERTIFICATE_OF_INCORPORATION"),
      file(input.statusReportUploadId, "CAC_STATUS_REPORT"),
      file(input.statusReportUploadId, "MEMORANDUM_OF_ASSOCIATION"),
      file(input.proofOfAddressUploadId, "PROOF_OF_ADDRESS"),
      // Anchor's KYB documents list has one director-ID slot; it takes the
      // primary signatory's.
      file(primaryDirector(input).idDocumentUploadId, "DIRECTOR_ID"),
      { documentType: "RC_NUMBER", text: input.registrationNumber },
      { documentType: "BN_NUMBER", text: input.registrationNumber },
      input.taxIdentificationNumber ? { documentType: "TIN", text: input.taxIdentificationNumber } : null,
    ].filter((document): document is BusinessDocument => document !== null);
    await paymentProvider.submitBusinessDocuments({ customerCode, documents });
  }

  private async toReviewSummary(context: DatabaseContext, profile: BankingProfileRow, withDownloadUrls: boolean): Promise<KybReviewSummary> {
    const directors = await repository.listKybDirectors(context, profile.businessId);
    const kybDocs = await repository.listKybDocuments(context, profile.businessId);
    const docTypeToKind: Record<string, KybReviewDocument["kind"]> = {
      CERTIFICATE_OF_INCORPORATION: "certificate_of_incorporation",
      CAC_STATUS_REPORT: "status_report",
      PROOF_OF_ADDRESS: "proof_of_address",
    };
    const businessSlots: [KybReviewDocument["kind"], string][] = kybDocs
      .filter((d) => docTypeToKind[d.documentType])
      .map((d) => [docTypeToKind[d.documentType]!, d.uploadId]);

    const uploadIds = [...businessSlots.map(([, id]) => id), ...directors.map((director) => director.idDocumentUploadId)].filter((id): id is string => !!id);
    const uploads = await repository.findUploads(context, uploadIds);
    const toDocument = async (kind: KybReviewDocument["kind"], uploadId: string | null): Promise<KybReviewDocument | null> => {
      const upload = uploads.find((candidate) => candidate.id === uploadId);
      if (!upload) return null;
      return {
        kind,
        uploadId: upload.id,
        mimeType: upload.mimeType,
        downloadUrl: withDownloadUrls && upload.status === "confirmed" ? await objectStorage.createPresignedDownloadUrl(upload.objectKey) : null,
      };
    };

    const documents = (await Promise.all(businessSlots.map(([kind, uploadId]) => toDocument(kind, uploadId)))).filter(
      (document): document is KybReviewDocument => document !== null,
    );
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
      directors: await Promise.all(
        directors.map(async (director) => ({
          isPrimary: director.isPrimary,
          fullName: director.fullName,
          email: director.email,
          phone: director.phone,
          bvnMasked: maskIdentifier(director.bvn)!,
          dateOfBirth: director.dateOfBirth,
          idType: director.idType,
          idNumberMasked: maskIdentifier(director.idNumber)!,
          idDocument: await toDocument("director_id", director.idDocumentUploadId),
        })),
      ),
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

  async listWithdrawals(operation: BankingOperation, filter: ListWithdrawalsFilter): Promise<{ withdrawals: WithdrawalRow[]; totalCount: number }> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "banking.read");
      return repository.listWithdrawals(context, operation.businessId, filter);
    });
  }

  async requestWithdrawal(operation: BankingOperation, input: RequestWithdrawalInput): Promise<WithdrawalRow> {
    return this.run(operation, (context) => this.requestWithdrawalIn(context, operation, input));
  }

  /**
   * The withdrawal flow inside a caller's transaction. Payables uses it to
   * pay a bill: same checks, gating and provider call, with the withdrawal
   * tied to the bill and gated by the bill-payment workflow instead.
   */
  async requestWithdrawalIn(context: DatabaseContext, operation: BankingPrincipal, input: RequestWithdrawalInput, bill?: WithdrawalBillLink): Promise<WithdrawalRow> {
    await requirePermission(context, operation.businessId, "banking.manage");

    if (await hasActiveHold(context, "business", operation.businessId)) {
      throw forbiddenError("This business's wallet is on hold; contact support before withdrawing.");
    }

    const existing = await repository.findWithdrawalByIdempotencyKey(context, operation.businessId, input.idempotencyKey);
    if (existing) return existing;

    const profile = await repository.findProfile(context, operation.businessId);
    if (!profile || profile.kycStatus === "not_started") {
      throw validationError("You haven't set up a business account yet. Set one up in Banking to send money from Scripe.", { reason: "banking_not_set_up" });
    }
    if (profile.kycStatus === "pending") {
      throw validationError("Your business account is still being verified. You can send money once it's approved.", { reason: "banking_pending" });
    }
    if (profile.kycStatus !== "verified") {
      throw validationError(
        `We couldn't verify your business account${profile.kycFailureReason ? `: ${profile.kycFailureReason}` : ""}. Fix it in Banking to send money from Scripe.`,
        { reason: "banking_failed" },
      );
    }

    const balance = await repository.getAvailableBalance(context, operation.businessId);
    if (BigInt(input.amountMinor) > BigInt(balance)) {
      throw validationError(`Your wallet has ${formatNaira(balance)} available. Top up to send ${formatNaira(String(input.amountMinor))}.`, { reason: "insufficient_balance" });
    }

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
    const submission = {
      subjectType: "withdrawal" as const,
      subjectId: withdrawalId,
      amountMinor: String(input.amountMinor),
      assetCode: ASSET_CODE,
      requestedBy: operation.userId,
      requestedByEmail: profile.email ?? "",
      requestedByIsOwner: isOwner,
      pendingPayload: bill ? { billId: bill.billId, billNumber: bill.billNumber, supplierName: bill.supplierName } : undefined,
    };
    // A transfer created from a bill never goes out by itself: it always
    // waits for the Bills approvers (or the owners). Other withdrawals are
    // gated only when the Transfers workflow is switched on.
    const gate: { gated: boolean; requestId?: string } = bill
      ? { gated: true, requestId: (await this.approvals.gateAlways(context, operation.businessId, "bill_payment", submission)).requestId }
      : await this.approvals.gateSubmission(context, operation.businessId, "withdrawal", submission);
    const description = bill ? `Bill payment · ${bill.billNumber}` : "Wallet withdrawal";

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
        billId: bill?.billId ?? null,
      });
      await repository.postWalletTransaction(context, operation.businessId, {
        type: "withdrawal",
        direction: "debit",
        status: "pending",
        assetCode: ASSET_CODE,
        amountMinor: String(input.amountMinor),
        provider: paymentProvider.name,
        providerReference: reference,
        description,
        metadata: { withdrawalId: withdrawal.id, approvalRequestId: gate.requestId, billId: bill?.billId },
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
      billId: bill?.billId ?? null,
    });
    await repository.postWalletTransaction(context, operation.businessId, {
      type: "withdrawal",
      direction: "debit",
      status: "pending",
      assetCode: ASSET_CODE,
      amountMinor: String(input.amountMinor),
      provider: paymentProvider.name,
      providerReference: reference,
      description,
      metadata: { withdrawalId: withdrawal.id, billId: bill?.billId },
    });

    const finalized = await this.callProviderAndFinalize(context, operation.businessId, withdrawal.id, reference, input.accountName, input.accountNumber, input.bankCode, String(input.amountMinor), profile.email, description);
    await this.logAction(context, operation, "banking.withdrawal_requested", "withdrawal", withdrawal.id, { amountMinor: input.amountMinor, billId: bill?.billId });
    return finalized;
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
      try {
        await this.callProviderAndFinalize(context, operation.businessId, withdrawal.id, withdrawal.providerReference, withdrawal.accountName, withdrawal.accountNumber, withdrawal.bankCode, withdrawal.amountMinor, profile?.email ?? null, withdrawal.billId ? "Bill payment" : "Wallet withdrawal");
      } catch (error) {
        // The approval is already recorded by now, so a provider failure
        // can't just roll back to "awaiting approval" — nobody could act on
        // it again and the money would stay held. Fail it and give the
        // money back instead; a bill it was paying stays owing.
        const reason = error instanceof AppError ? error.message : "The bank couldn't take this transfer";
        await repository.updateWithdrawal(context, withdrawal.id, { status: "failed", failureReason: reason });
        await repository.postWalletTransaction(context, operation.businessId, {
          type: "reversal",
          direction: "credit",
          status: "posted",
          assetCode: withdrawal.assetCode,
          amountMinor: withdrawal.amountMinor,
          provider: paymentProvider.name,
          providerReference: `${withdrawal.providerReference}:reversal`,
          description: "Withdrawal reversal — the bank couldn't take the transfer",
          metadata: { withdrawalId: withdrawal.id },
        });
        await this.logAction(context, operation, "banking.withdrawal_failed", "withdrawal", withdrawal.id, { reason });
        return;
      }
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
    reason: string,
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
      reason,
      sourceAccountId: virtualAccount?.providerAccountId,
      customerEmail,
    });
    const finalized = await repository.updateWithdrawal(context, withdrawalId, {
      status: transfer.status,
      transferRecipientCode: recipient.recipientCode,
      providerTransferCode: transfer.transferCode,
    });
    // A provider that confirms on the spot never sends the webhook that
    // would otherwise settle a bill payment.
    if (transfer.status === "success") await repository.settleBillWithdrawal(context, withdrawalId);
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
        await repository.settleBillWithdrawal(context, withdrawal.id);
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
  return [
    input.certificateOfIncorporationUploadId,
    input.proofOfAddressUploadId,
    input.statusReportUploadId,
    ...input.directors.map((director) => director.idDocumentUploadId),
  ].filter((id): id is string => !!id);
}

/** The schema guarantees exactly one primary director. */
function primaryDirector(input: SubmitKybInput): SubmitKybInput["directors"][number] {
  return input.directors.find((director) => director.isPrimary)!;
}
