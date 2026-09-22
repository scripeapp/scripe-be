import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./compliance.repository.js";
import type {
  BeneficialOwner,
  BeneficialOwnerRow,
  ComplianceCase,
  ComplianceCaseRow,
  ComplianceCaseStatus,
  ComplianceDocument,
  ComplianceDocumentRow,
  ComplianceOperation,
  ComplianceSubmission,
  ComplianceSubmissionRow,
  CreateBeneficialOwnerInput,
  CreateDataPrivacyRequestInput,
  CreateDocumentInput,
  CreateSubmissionInput,
  DataPrivacyRequest,
  DataPrivacyRequestRow,
  GrantConsentInput,
  LegalProfile,
  LegalProfileRow,
  PersonalOperation,
  UpdateBeneficialOwnerInput,
  UpsertLegalProfileInput,
  UserConsent,
  UserConsentRow,
} from "./compliance.types.js";

export class ComplianceService {
  constructor(private readonly database: Database) {}

  // --------------------------------------------------------------------
  // Legal profile
  // --------------------------------------------------------------------

  async getLegalProfile(operation: ComplianceOperation): Promise<LegalProfile> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      const row = await repository.findLegalProfile(context, operation.businessId);
      if (!row) throw notFoundError("Legal profile has not been set for this business");
      return toLegalProfile(row);
    });
  }

  async upsertLegalProfile(operation: ComplianceOperation, input: UpsertLegalProfileInput): Promise<LegalProfile> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      return toLegalProfile(await repository.upsertLegalProfile(context, operation.businessId, operation.userId, input));
    });
  }

  // --------------------------------------------------------------------
  // Beneficial owners
  // --------------------------------------------------------------------

  async listBeneficialOwners(operation: ComplianceOperation): Promise<BeneficialOwner[]> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      return (await repository.listBeneficialOwners(context, operation.businessId)).map(toBeneficialOwner);
    });
  }

  async createBeneficialOwner(operation: ComplianceOperation, input: CreateBeneficialOwnerInput): Promise<BeneficialOwner> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      return toBeneficialOwner(await repository.createBeneficialOwner(context, operation.businessId, operation.userId, input));
    });
  }

  async updateBeneficialOwner(operation: ComplianceOperation, ownerId: string, input: UpdateBeneficialOwnerInput): Promise<BeneficialOwner> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      const updated = await repository.updateBeneficialOwner(context, operation.businessId, ownerId, input);
      if (!updated) throw notFoundError("Beneficial owner not found");
      return toBeneficialOwner(updated);
    });
  }

  async archiveBeneficialOwner(operation: ComplianceOperation, ownerId: string): Promise<void> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      if (!(await repository.archiveBeneficialOwner(context, operation.businessId, ownerId))) throw notFoundError("Beneficial owner not found");
    });
  }

  // --------------------------------------------------------------------
  // Compliance cases
  // --------------------------------------------------------------------

  async listCases(operation: ComplianceOperation): Promise<ComplianceCase[]> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      return (await repository.listCases(context, operation.businessId)).map(toCase);
    });
  }

  async getCase(operation: ComplianceOperation, caseId: string): Promise<ComplianceCase> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      const row = await repository.findCase(context, operation.businessId, caseId);
      if (!row) throw notFoundError("Compliance case not found");
      return toCase(row);
    });
  }

  async openCase(operation: ComplianceOperation): Promise<ComplianceCase> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      const legalProfile = await repository.findLegalProfile(context, operation.businessId);
      if (!legalProfile) throw validationError("Set the business's legal profile before opening a compliance case");
      return toCase(await repository.openCase(context, operation.businessId, operation.userId));
    });
  }

  async updateCaseStatus(operation: ComplianceOperation, caseId: string, status: ComplianceCaseStatus, notes?: string | null): Promise<ComplianceCase> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      const updated = await repository.updateCaseStatus(context, operation.businessId, caseId, status, notes);
      if (!updated) throw notFoundError("Compliance case not found");
      return toCase(updated);
    });
  }

  // --------------------------------------------------------------------
  // Documents (metadata only)
  // --------------------------------------------------------------------

  async listDocuments(operation: ComplianceOperation, caseId: string): Promise<ComplianceDocument[]> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      await this.requireCase(context, operation.businessId, caseId);
      return (await repository.listDocuments(context, operation.businessId, caseId)).map(toDocument);
    });
  }

  async addDocument(operation: ComplianceOperation, caseId: string, input: CreateDocumentInput): Promise<ComplianceDocument> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      await this.requireCase(context, operation.businessId, caseId);
      return toDocument(await repository.createDocument(context, operation.businessId, caseId, operation.userId, input));
    });
  }

  // --------------------------------------------------------------------
  // Submissions (attempts only — no live provider call)
  // --------------------------------------------------------------------

  async listSubmissions(operation: ComplianceOperation, caseId: string): Promise<ComplianceSubmission[]> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.read");
      await this.requireCase(context, operation.businessId, caseId);
      return (await repository.listSubmissions(context, operation.businessId, caseId)).map(toSubmission);
    });
  }

  async recordSubmission(operation: ComplianceOperation, caseId: string, input: CreateSubmissionInput): Promise<ComplianceSubmission> {
    return this.runBusiness(operation, async (context) => {
      await requirePermission(context, operation.businessId, "compliance.manage");
      const complianceCase = await this.requireCase(context, operation.businessId, caseId);
      const submission = await repository.createSubmission(context, operation.businessId, caseId, operation.userId, input);
      if (complianceCase.status === "draft") {
        await repository.updateCaseStatus(context, operation.businessId, caseId, "in_review", undefined);
      }
      return toSubmission(submission);
    });
  }

  private async requireCase(context: DatabaseContext, businessId: string, caseId: string): Promise<ComplianceCaseRow> {
    const complianceCase = await repository.findCase(context, businessId, caseId);
    if (!complianceCase) throw notFoundError("Compliance case not found");
    return complianceCase;
  }

  // --------------------------------------------------------------------
  // Personal: consents
  // --------------------------------------------------------------------

  async listConsents(operation: PersonalOperation): Promise<UserConsent[]> {
    return this.runPersonal(operation, async (context) => (await repository.listConsents(context, operation.userId)).map(toConsent));
  }

  async grantConsent(operation: PersonalOperation, input: GrantConsentInput): Promise<UserConsent> {
    return this.runPersonal(operation, async (context) => toConsent(await repository.grantConsent(context, operation.userId, input)));
  }

  async revokeConsent(operation: PersonalOperation, consentId: string): Promise<void> {
    return this.runPersonal(operation, async (context) => {
      if (!(await repository.revokeConsent(context, operation.userId, consentId))) throw notFoundError("Consent record not found");
    });
  }

  // --------------------------------------------------------------------
  // Personal: NDPR data-privacy requests
  // --------------------------------------------------------------------

  async listPrivacyRequests(operation: PersonalOperation): Promise<DataPrivacyRequest[]> {
    return this.runPersonal(operation, async (context) => (await repository.listPrivacyRequests(context, operation.userId)).map(toPrivacyRequest));
  }

  async createPrivacyRequest(operation: PersonalOperation, input: CreateDataPrivacyRequestInput): Promise<DataPrivacyRequest> {
    return this.runPersonal(operation, async (context) => {
      if (input.businessId && !(await repository.verifyBusinessMembership(context, operation.userId, input.businessId))) {
        throw conflictError("You are not a member of this business");
      }
      return toPrivacyRequest(await repository.createPrivacyRequest(context, operation.userId, input));
    });
  }

  private async runBusiness<T>(operation: ComplianceOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    return this.run(operation.requestId, operation.userId, operation.businessId, work);
  }

  private async runPersonal<T>(operation: PersonalOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    return this.run(operation.requestId, operation.userId, null, work);
  }

  private async run<T>(requestId: string, userId: string, businessId: string | null, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(requestId, userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toLegalProfile(row: LegalProfileRow): LegalProfile {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toBeneficialOwner(row: BeneficialOwnerRow): BeneficialOwner {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null };
}

function toCase(row: ComplianceCaseRow): ComplianceCase {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), closedAt: row.closedAt?.toISOString() ?? null };
}

function toDocument(row: ComplianceDocumentRow): ComplianceDocument {
  return { ...row, expiresAt: row.expiresAt?.toISOString() ?? null, retentionUntil: row.retentionUntil?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

function toSubmission(row: ComplianceSubmissionRow): ComplianceSubmission {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function toConsent(row: UserConsentRow): UserConsent {
  return { ...row, grantedAt: row.grantedAt.toISOString(), revokedAt: row.revokedAt?.toISOString() ?? null };
}

function toPrivacyRequest(row: DataPrivacyRequestRow): DataPrivacyRequest {
  return { ...row, dueAt: row.dueAt.toISOString(), createdAt: row.createdAt.toISOString() };
}
