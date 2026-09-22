import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  BeneficialOwnerRow,
  ComplianceCaseRow,
  ComplianceDocumentRow,
  ComplianceSubmissionRow,
  CreateBeneficialOwnerInput,
  CreateDataPrivacyRequestInput,
  CreateDocumentInput,
  CreateSubmissionInput,
  DataPrivacyRequestRow,
  GrantConsentInput,
  LegalProfileRow,
  UpdateBeneficialOwnerInput as UpdateOwnerInput,
  UpsertLegalProfileInput,
  UserConsentRow,
} from "./compliance.types.js";

// ============================================================================
// Legal profile (1:1 per business)
// ============================================================================

const LEGAL_PROFILE_COLUMNS = sql`
  "businessId", "registeredName", "registrationNumber", "taxIdentificationNumber", "countryCode",
  "addressLine1", "addressLine2", "city", "state", "postalCode", "createdBy", "createdAt", "updatedAt"
`;

export async function findLegalProfile(context: DatabaseContext, businessId: string): Promise<LegalProfileRow | undefined> {
  const result = await sql<LegalProfileRow>`
    select ${LEGAL_PROFILE_COLUMNS} from app.business_legal_profiles where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function upsertLegalProfile(context: DatabaseContext, businessId: string, userId: string, input: UpsertLegalProfileInput): Promise<LegalProfileRow> {
  const result = await sql<LegalProfileRow>`
    insert into app.business_legal_profiles (
      "businessId", "registeredName", "registrationNumber", "taxIdentificationNumber", "countryCode",
      "addressLine1", "addressLine2", "city", "state", "postalCode", "createdBy"
    ) values (
      ${businessId}::uuid, ${input.registeredName}, ${input.registrationNumber}, ${input.taxIdentificationNumber ?? null}, ${input.countryCode ?? "NG"},
      ${input.addressLine1}, ${input.addressLine2 ?? null}, ${input.city}, ${input.state}, ${input.postalCode ?? null}, ${userId}::uuid
    )
    on conflict ("businessId") do update set
      "registeredName" = excluded."registeredName",
      "registrationNumber" = excluded."registrationNumber",
      "taxIdentificationNumber" = excluded."taxIdentificationNumber",
      "countryCode" = excluded."countryCode",
      "addressLine1" = excluded."addressLine1",
      "addressLine2" = excluded."addressLine2",
      "city" = excluded."city",
      "state" = excluded."state",
      "postalCode" = excluded."postalCode",
      "updatedAt" = now()
    returning ${LEGAL_PROFILE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

// ============================================================================
// Beneficial owners
// ============================================================================

const OWNER_COLUMNS = sql`
  "id", "businessId", "fullName", "relationship", "ownershipPercentageBps", "idType", "idNumber",
  "nationality", "createdBy", "createdAt", "updatedAt", "archivedAt"
`;

export async function listBeneficialOwners(context: DatabaseContext, businessId: string): Promise<BeneficialOwnerRow[]> {
  const result = await sql<BeneficialOwnerRow>`
    select ${OWNER_COLUMNS} from app.beneficial_owners
    where "businessId" = ${businessId}::uuid and "archivedAt" is null
    order by "createdAt"
  `.execute(context.transaction);
  return result.rows;
}

export async function findBeneficialOwner(context: DatabaseContext, businessId: string, ownerId: string): Promise<BeneficialOwnerRow | undefined> {
  const result = await sql<BeneficialOwnerRow>`
    select ${OWNER_COLUMNS} from app.beneficial_owners where "businessId" = ${businessId}::uuid and "id" = ${ownerId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createBeneficialOwner(context: DatabaseContext, businessId: string, userId: string, input: CreateBeneficialOwnerInput): Promise<BeneficialOwnerRow> {
  const result = await sql<BeneficialOwnerRow>`
    insert into app.beneficial_owners ("businessId", "fullName", "relationship", "ownershipPercentageBps", "idType", "idNumber", "nationality", "createdBy")
    values (${businessId}::uuid, ${input.fullName}, ${input.relationship}, ${input.ownershipPercentageBps ?? null}, ${input.idType}, ${input.idNumber}, ${input.nationality ?? "NG"}, ${userId}::uuid)
    returning ${OWNER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateBeneficialOwner(context: DatabaseContext, businessId: string, ownerId: string, input: UpdateOwnerInput): Promise<BeneficialOwnerRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.fullName !== undefined) fields.push(sql`"fullName" = ${input.fullName}`);
  if (input.relationship !== undefined) fields.push(sql`"relationship" = ${input.relationship}`);
  if (input.ownershipPercentageBps !== undefined) fields.push(sql`"ownershipPercentageBps" = ${input.ownershipPercentageBps}`);
  if (input.idType !== undefined) fields.push(sql`"idType" = ${input.idType}`);
  if (input.idNumber !== undefined) fields.push(sql`"idNumber" = ${input.idNumber}`);
  if (input.nationality !== undefined) fields.push(sql`"nationality" = ${input.nationality}`);
  if (fields.length === 0) return findBeneficialOwner(context, businessId, ownerId);

  const result = await sql<BeneficialOwnerRow>`
    update app.beneficial_owners set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${ownerId}::uuid and "archivedAt" is null
    returning ${OWNER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function archiveBeneficialOwner(context: DatabaseContext, businessId: string, ownerId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.beneficial_owners set "archivedAt" = now()
    where "businessId" = ${businessId}::uuid and "id" = ${ownerId}::uuid and "archivedAt" is null
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ============================================================================
// Compliance cases
// ============================================================================

const CASE_COLUMNS = sql`"id", "businessId", "status", "notes", "createdBy", "createdAt", "updatedAt", "closedAt"`;

export async function listCases(context: DatabaseContext, businessId: string): Promise<ComplianceCaseRow[]> {
  const result = await sql<ComplianceCaseRow>`
    select ${CASE_COLUMNS} from app.compliance_cases where "businessId" = ${businessId}::uuid order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findCase(context: DatabaseContext, businessId: string, caseId: string): Promise<ComplianceCaseRow | undefined> {
  const result = await sql<ComplianceCaseRow>`
    select ${CASE_COLUMNS} from app.compliance_cases where "businessId" = ${businessId}::uuid and "id" = ${caseId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function openCase(context: DatabaseContext, businessId: string, userId: string): Promise<ComplianceCaseRow> {
  const result = await sql<ComplianceCaseRow>`
    insert into app.compliance_cases ("businessId", "createdBy") values (${businessId}::uuid, ${userId}::uuid)
    returning ${CASE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

const TERMINAL_STATUSES = ["approved", "rejected"] as const;

export async function updateCaseStatus(context: DatabaseContext, businessId: string, caseId: string, status: ComplianceCaseRow["status"], notes: string | null | undefined): Promise<ComplianceCaseRow | undefined> {
  const closesNow = (TERMINAL_STATUSES as readonly string[]).includes(status);
  const notesClause = notes !== undefined ? sql`, "notes" = ${notes}` : sql``;
  const result = await sql<ComplianceCaseRow>`
    update app.compliance_cases set "status" = ${status}, "closedAt" = ${closesNow ? sql`now()` : sql`"closedAt"`} ${notesClause}
    where "businessId" = ${businessId}::uuid and "id" = ${caseId}::uuid
    returning ${CASE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

// ============================================================================
// Compliance documents (metadata only — no upload flow in this slice)
// ============================================================================

export async function listDocuments(context: DatabaseContext, businessId: string, caseId: string): Promise<ComplianceDocumentRow[]> {
  const result = await sql<ComplianceDocumentRow>`
    select "id", "businessId", "caseId", "type", "objectKey", "mimeType", "sizeBytes"::text, "expiresAt", "retentionUntil", "uploadedBy", "createdAt"
    from app.compliance_documents where "businessId" = ${businessId}::uuid and "caseId" = ${caseId}::uuid
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function createDocument(context: DatabaseContext, businessId: string, caseId: string, userId: string, input: CreateDocumentInput): Promise<ComplianceDocumentRow> {
  const result = await sql<ComplianceDocumentRow>`
    insert into app.compliance_documents ("businessId", "caseId", "type", "objectKey", "mimeType", "sizeBytes", "expiresAt", "retentionUntil", "uploadedBy")
    values (${businessId}::uuid, ${caseId}::uuid, ${input.type}, ${input.objectKey}, ${input.mimeType}, ${input.sizeBytes}::bigint, ${input.expiresAt ?? null}::timestamptz, ${input.retentionUntil ?? null}::timestamptz, ${userId}::uuid)
    returning "id", "businessId", "caseId", "type", "objectKey", "mimeType", "sizeBytes"::text, "expiresAt", "retentionUntil", "uploadedBy", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

// ============================================================================
// Compliance submissions (attempts only — no live provider call)
// ============================================================================

export async function listSubmissions(context: DatabaseContext, businessId: string, caseId: string): Promise<ComplianceSubmissionRow[]> {
  const result = await sql<ComplianceSubmissionRow>`
    select "id", "businessId", "caseId", "provider", "status", "externalReference", "responseSnapshot", "submittedBy", "createdAt"
    from app.compliance_submissions where "businessId" = ${businessId}::uuid and "caseId" = ${caseId}::uuid
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function createSubmission(context: DatabaseContext, businessId: string, caseId: string, userId: string, input: CreateSubmissionInput): Promise<ComplianceSubmissionRow> {
  const result = await sql<ComplianceSubmissionRow>`
    insert into app.compliance_submissions ("businessId", "caseId", "provider", "status", "externalReference", "responseSnapshot", "submittedBy")
    values (${businessId}::uuid, ${caseId}::uuid, ${input.provider}, ${input.status ?? "pending"}, ${input.externalReference ?? null}, ${JSON.stringify(input.responseSnapshot ?? {})}::jsonb, ${userId}::uuid)
    returning "id", "businessId", "caseId", "provider", "status", "externalReference", "responseSnapshot", "submittedBy", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

// ============================================================================
// Personal: consents
// ============================================================================

export async function listConsents(context: DatabaseContext, userId: string): Promise<UserConsentRow[]> {
  const result = await sql<UserConsentRow>`
    select "id", "userId", "consentType", "version", "grantedAt", "revokedAt" from app.user_consents
    where "userId" = ${userId}::uuid order by "grantedAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function grantConsent(context: DatabaseContext, userId: string, input: GrantConsentInput): Promise<UserConsentRow> {
  const result = await sql<UserConsentRow>`
    insert into app.user_consents ("userId", "consentType", "version")
    values (${userId}::uuid, ${input.consentType}, ${input.version})
    on conflict ("userId", "consentType", "version") do update set "revokedAt" = null, "grantedAt" = now()
    returning "id", "userId", "consentType", "version", "grantedAt", "revokedAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function revokeConsent(context: DatabaseContext, userId: string, consentId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.user_consents set "revokedAt" = now()
    where "userId" = ${userId}::uuid and "id" = ${consentId}::uuid and "revokedAt" is null
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ============================================================================
// Personal: data-privacy requests
// ============================================================================

export async function listPrivacyRequests(context: DatabaseContext, userId: string): Promise<DataPrivacyRequestRow[]> {
  const result = await sql<DataPrivacyRequestRow>`
    select "id", "userId", "businessId", "type", "status", "description", "dueAt", "createdAt" from app.data_privacy_requests
    where "userId" = ${userId}::uuid order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

const NDPR_RESPONSE_WINDOW_DAYS = 30;

export async function createPrivacyRequest(context: DatabaseContext, userId: string, input: CreateDataPrivacyRequestInput): Promise<DataPrivacyRequestRow> {
  const result = await sql<DataPrivacyRequestRow>`
    insert into app.data_privacy_requests ("userId", "businessId", "type", "description", "dueAt")
    values (${userId}::uuid, ${input.businessId ?? null}::uuid, ${input.type}, ${input.description ?? null}, now() + make_interval(days => ${NDPR_RESPONSE_WINDOW_DAYS}))
    returning "id", "userId", "businessId", "type", "status", "description", "dueAt", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function verifyBusinessMembership(context: DatabaseContext, userId: string, businessId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    select "id" from app.business_memberships
    where "businessId" = ${businessId}::uuid and "userId" = ${userId}::uuid and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows.length > 0;
}
