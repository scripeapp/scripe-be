// ============================================================================
// Business-scoped KYB
// ============================================================================

export interface LegalProfileRow {
  readonly businessId: string;
  readonly registeredName: string;
  readonly registrationNumber: string;
  readonly taxIdentificationNumber: string | null;
  readonly countryCode: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LegalProfile extends Omit<LegalProfileRow, "createdAt" | "updatedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type BeneficialOwnerRelationship = "director" | "shareholder" | "ultimate_beneficial_owner";
export type BeneficialOwnerIdType = "nin" | "passport" | "drivers_license" | "voters_card";

export interface BeneficialOwnerRow {
  readonly id: string;
  readonly businessId: string;
  readonly fullName: string;
  readonly relationship: BeneficialOwnerRelationship;
  readonly ownershipPercentageBps: number | null;
  readonly idType: BeneficialOwnerIdType;
  readonly idNumber: string;
  readonly nationality: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface BeneficialOwner extends Omit<BeneficialOwnerRow, "createdAt" | "updatedAt" | "archivedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export type ComplianceCaseStatus = "draft" | "in_review" | "approved" | "rejected" | "requires_more_info";

export interface ComplianceCaseRow {
  readonly id: string;
  readonly businessId: string;
  readonly status: ComplianceCaseStatus;
  readonly notes: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly closedAt: Date | null;
}

export interface ComplianceCase extends Omit<ComplianceCaseRow, "createdAt" | "updatedAt" | "closedAt"> {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

export type ComplianceDocumentType = "certificate_of_incorporation" | "tax_certificate" | "proof_of_address" | "identity_document" | "other";

export interface ComplianceDocumentRow {
  readonly id: string;
  readonly businessId: string;
  readonly caseId: string;
  readonly type: ComplianceDocumentType;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly expiresAt: Date | null;
  readonly retentionUntil: Date | null;
  readonly uploadedBy: string;
  readonly createdAt: Date;
}

export interface ComplianceDocument extends Omit<ComplianceDocumentRow, "expiresAt" | "retentionUntil" | "createdAt"> {
  readonly expiresAt: string | null;
  readonly retentionUntil: string | null;
  readonly createdAt: string;
}

export type ComplianceSubmissionProvider = "brails" | "anchor";
export type ComplianceSubmissionStatus = "pending" | "succeeded" | "failed";

export interface ComplianceSubmissionRow {
  readonly id: string;
  readonly businessId: string;
  readonly caseId: string;
  readonly provider: ComplianceSubmissionProvider;
  readonly status: ComplianceSubmissionStatus;
  readonly externalReference: string | null;
  readonly responseSnapshot: Record<string, unknown>;
  readonly submittedBy: string;
  readonly createdAt: Date;
}

export interface ComplianceSubmission extends Omit<ComplianceSubmissionRow, "createdAt"> {
  readonly createdAt: string;
}

export interface ComplianceOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface UpsertLegalProfileInput {
  readonly registeredName: string;
  readonly registrationNumber: string;
  readonly taxIdentificationNumber?: string | null;
  readonly countryCode?: string;
  readonly addressLine1: string;
  readonly addressLine2?: string | null;
  readonly city: string;
  readonly state: string;
  readonly postalCode?: string | null;
}

export interface CreateBeneficialOwnerInput {
  readonly fullName: string;
  readonly relationship: BeneficialOwnerRelationship;
  readonly ownershipPercentageBps?: number | null;
  readonly idType: BeneficialOwnerIdType;
  readonly idNumber: string;
  readonly nationality?: string;
}

export type UpdateBeneficialOwnerInput = Partial<CreateBeneficialOwnerInput>;

export interface CreateSubmissionInput {
  readonly provider: ComplianceSubmissionProvider;
  readonly status?: ComplianceSubmissionStatus;
  readonly externalReference?: string | null;
  readonly responseSnapshot?: Record<string, unknown>;
}

export interface CreateDocumentInput {
  readonly type: ComplianceDocumentType;
  readonly objectKey: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly expiresAt?: string | null;
  readonly retentionUntil?: string | null;
}

// ============================================================================
// Personal: consents and data-privacy requests
// ============================================================================

export type ConsentType = "terms" | "privacy" | "marketing";

export interface UserConsentRow {
  readonly id: string;
  readonly userId: string;
  readonly consentType: ConsentType;
  readonly version: string;
  readonly grantedAt: Date;
  readonly revokedAt: Date | null;
}

export interface UserConsent extends Omit<UserConsentRow, "grantedAt" | "revokedAt"> {
  readonly grantedAt: string;
  readonly revokedAt: string | null;
}

export type DataPrivacyRequestType = "access" | "deletion" | "portability" | "rectification" | "objection";
export type DataPrivacyRequestStatus = "pending" | "processing" | "completed" | "rejected";

export interface DataPrivacyRequestRow {
  readonly id: string;
  readonly userId: string;
  readonly businessId: string | null;
  readonly type: DataPrivacyRequestType;
  readonly status: DataPrivacyRequestStatus;
  readonly description: string | null;
  readonly dueAt: Date;
  readonly createdAt: Date;
}

export interface DataPrivacyRequest extends Omit<DataPrivacyRequestRow, "dueAt" | "createdAt"> {
  readonly dueAt: string;
  readonly createdAt: string;
}

export interface PersonalOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface GrantConsentInput {
  readonly consentType: ConsentType;
  readonly version: string;
}

export interface CreateDataPrivacyRequestInput {
  readonly type: DataPrivacyRequestType;
  readonly description?: string;
  readonly businessId?: string | null;
}
