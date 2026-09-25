import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { decryptPii, encryptPii } from "../../shared/pii-crypto.js";
import type {
  BankingProfileRow,
  BusinessAddressInput,
  BusinessType,
  ProviderCustomerType,
  KycStatus,
  ListWalletTransactionsFilter,
  VirtualAccountRow,
  VirtualAccountStatus,
  WalletTransactionDirection,
  WalletTransactionRow,
  WalletTransactionStatus,
  WalletTransactionType,
  WithdrawalRow,
  WithdrawalStatus,
} from "./banking.types.js";

const PROFILE_COLUMNS = `"businessId", "kycStatus", "kycFailureReason", "kycSubmittedAt", "kycVerifiedAt", "providerCustomerCode", "providerCustomerType", "notificationEmail", "email", "firstName", "lastName", "phone", "bvn", "businessType", "registeredBusinessName", "registrationNumber", "taxIdentificationNumber", "dateOfRegistration"::text as "dateOfRegistration", "website", "description", "businessCategory", "annualRevenue", "businessAddress", "directorNin", "directorDob", "directorIdType", "directorIdNumber", "directorIdDocumentUploadId", "certificateOfIncorporationUploadId", "statusReportUploadId", "proofOfAddressUploadId", "settlementBankCode", "settlementAccountNumber", "settlementAccountName", "kybReviewedBy", "kybReviewedAt", "kybReviewNotes", "createdAt", "updatedAt"`;
const VIRTUAL_ACCOUNT_COLUMNS = `"id", "businessId", "provider", "providerCustomerCode", "providerAccountId", "accountNumber", "accountName", "bankName", "bankSlug", "assetCode", "status", "assignmentReference", "failureReason", "metadata", "lastRequeryAt", "createdAt", "updatedAt"`;
const WALLET_TRANSACTION_COLUMNS = `"id", "businessId", "type", "direction", "status", "assetCode", "amountMinor", "grossAmountMinor", "feeAmountMinor", "feeBreakdown", "provider", "providerReference", "description", "metadata", "postedAt", "createdAt"`;
const WITHDRAWAL_COLUMNS = `"id", "businessId", "requestedBy", "amountMinor", "assetCode", "bankCode", "accountNumber", "accountName", "transferRecipientCode", "providerReference", "providerTransferCode", "idempotencyKey", "status", "failureReason", "createdAt", "updatedAt"`;

function decryptProfile(row: BankingProfileRow | undefined): BankingProfileRow | undefined {
  if (!row) return undefined;
  return {
    ...row,
    bvn: decryptPii(row.bvn),
    directorNin: decryptPii(row.directorNin),
    directorDob: decryptPii(row.directorDob),
    directorIdNumber: decryptPii(row.directorIdNumber),
  };
}

export async function findProfile(context: DatabaseContext, businessId: string): Promise<BankingProfileRow | undefined> {
  const result = await sql<BankingProfileRow>`
    select ${sql.raw(PROFILE_COLUMNS)} from app.banking_profiles where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return decryptProfile(result.rows[0]);
}

/**
 * Persists a freshly created provider customer on its own, before any
 * further provider call can fail — otherwise a failed verification rolls
 * back the only record of a customer that already exists at the provider,
 * and every retry creates another orphan.
 */
export async function saveProviderCustomer(
  context: DatabaseContext,
  businessId: string,
  fields: { providerCustomerCode: string; providerCustomerType: ProviderCustomerType; notificationEmail: string },
): Promise<void> {
  await sql`
    insert into app.banking_profiles ("businessId", "kycStatus", "providerCustomerCode", "providerCustomerType", "notificationEmail")
    values (${businessId}::uuid, 'not_started', ${fields.providerCustomerCode}, ${fields.providerCustomerType}, ${fields.notificationEmail})
    on conflict ("businessId") do update set
      "providerCustomerCode" = excluded."providerCustomerCode",
      "providerCustomerType" = excluded."providerCustomerType",
      "notificationEmail" = excluded."notificationEmail",
      "updatedAt" = now()
  `.execute(context.transaction);
}

/** Replaces the whole submission — nothing from an earlier (failed or different-type) attempt survives. */
export async function saveIndividualSubmission(
  context: DatabaseContext,
  businessId: string,
  fields: {
    kycStatus: "pending" | "verified";
    notificationEmail: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    bvn: string;
    settlementBankCode: string;
    settlementAccountNumber: string;
  },
): Promise<BankingProfileRow> {
  const result = await sql<BankingProfileRow>`
    update app.banking_profiles set
      "kycStatus" = ${fields.kycStatus},
      "kycFailureReason" = null,
      "kycSubmittedAt" = now(),
      "kycVerifiedAt" = case when ${fields.kycStatus} = 'verified' then now() else null end,
      "notificationEmail" = ${fields.notificationEmail},
      "email" = ${fields.email},
      "firstName" = ${fields.firstName},
      "lastName" = ${fields.lastName},
      "phone" = ${fields.phone},
      "bvn" = ${encryptPii(fields.bvn)},
      "businessType" = null,
      "registeredBusinessName" = null,
      "registrationNumber" = null,
      "taxIdentificationNumber" = null,
      "dateOfRegistration" = null,
      "website" = null,
      "description" = null,
      "businessCategory" = null,
      "annualRevenue" = null,
      "businessAddress" = null,
      "directorNin" = null,
      "directorDob" = null,
      "directorIdType" = null,
      "directorIdNumber" = null,
      "directorIdDocumentUploadId" = null,
      "certificateOfIncorporationUploadId" = null,
      "statusReportUploadId" = null,
      "proofOfAddressUploadId" = null,
      "settlementBankCode" = ${fields.settlementBankCode},
      "settlementAccountNumber" = ${fields.settlementAccountNumber},
      "settlementAccountName" = null,
      "kybReviewedBy" = null,
      "kybReviewedAt" = null,
      "kybReviewNotes" = null,
      "updatedAt" = now()
    where "businessId" = ${businessId}::uuid
    returning ${sql.raw(PROFILE_COLUMNS)}
  `.execute(context.transaction);
  return decryptProfile(result.rows[0])!;
}

export async function saveBusinessSubmission(
  context: DatabaseContext,
  businessId: string,
  fields: {
    notificationEmail: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    bvn: string;
    businessType: BusinessType;
    registeredBusinessName: string;
    registrationNumber: string;
    taxIdentificationNumber: string | null;
    dateOfRegistration: string;
    website: string | null;
    description: string | null;
    businessCategory: string;
    annualRevenue: string | null;
    businessAddress: BusinessAddressInput;
    directorNin: string | null;
    directorDob: string;
    directorIdType: string;
    directorIdNumber: string;
    directorIdDocumentUploadId: string;
    certificateOfIncorporationUploadId: string;
    statusReportUploadId: string | null;
    proofOfAddressUploadId: string;
    settlementBankCode: string;
    settlementAccountNumber: string;
    settlementAccountName: string;
  },
): Promise<BankingProfileRow> {
  const result = await sql<BankingProfileRow>`
    update app.banking_profiles set
      "kycStatus" = 'pending',
      "kycFailureReason" = null,
      "kycSubmittedAt" = now(),
      "kycVerifiedAt" = null,
      "notificationEmail" = ${fields.notificationEmail},
      "email" = ${fields.email},
      "firstName" = ${fields.firstName},
      "lastName" = ${fields.lastName},
      "phone" = ${fields.phone},
      "bvn" = ${encryptPii(fields.bvn)},
      "businessType" = ${fields.businessType},
      "registeredBusinessName" = ${fields.registeredBusinessName},
      "registrationNumber" = ${fields.registrationNumber},
      "taxIdentificationNumber" = ${fields.taxIdentificationNumber},
      "dateOfRegistration" = ${fields.dateOfRegistration}::date,
      "website" = ${fields.website},
      "description" = ${fields.description},
      "businessCategory" = ${fields.businessCategory},
      "annualRevenue" = ${fields.annualRevenue},
      "businessAddress" = ${JSON.stringify(fields.businessAddress)}::jsonb,
      "directorNin" = ${encryptPii(fields.directorNin)},
      "directorDob" = ${encryptPii(fields.directorDob)},
      "directorIdType" = ${fields.directorIdType},
      "directorIdNumber" = ${encryptPii(fields.directorIdNumber)},
      "directorIdDocumentUploadId" = ${fields.directorIdDocumentUploadId}::uuid,
      "certificateOfIncorporationUploadId" = ${fields.certificateOfIncorporationUploadId}::uuid,
      "statusReportUploadId" = ${fields.statusReportUploadId}::uuid,
      "proofOfAddressUploadId" = ${fields.proofOfAddressUploadId}::uuid,
      "settlementBankCode" = ${fields.settlementBankCode},
      "settlementAccountNumber" = ${fields.settlementAccountNumber},
      "settlementAccountName" = ${fields.settlementAccountName},
      "kybReviewedBy" = null,
      "kybReviewedAt" = null,
      "kybReviewNotes" = null,
      "updatedAt" = now()
    where "businessId" = ${businessId}::uuid
    returning ${sql.raw(PROFILE_COLUMNS)}
  `.execute(context.transaction);
  return decryptProfile(result.rows[0])!;
}

/** Only individual profiles are promoted by an issued account — a business needs KYB review. */
export async function markIndividualProfileVerified(context: DatabaseContext, businessId: string): Promise<void> {
  await sql`
    update app.banking_profiles set "kycStatus" = 'verified', "kycVerifiedAt" = now(), "updatedAt" = now()
    where "businessId" = ${businessId}::uuid and "kycStatus" <> 'verified' and coalesce("providerCustomerType", 'individual') = 'individual'
  `.execute(context.transaction);
}

export async function recordKycAttempt(context: DatabaseContext, businessId: string, userId: string, kind: ProviderCustomerType): Promise<void> {
  await sql`
    insert into app.banking_kyc_attempts ("businessId", "userId", "kind") values (${businessId}::uuid, ${userId}::uuid, ${kind})
  `.execute(context.transaction);
}

export async function countKycAttemptsSince(context: DatabaseContext, businessId: string, since: Date): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as "count" from app.banking_kyc_attempts where "businessId" = ${businessId}::uuid and "createdAt" >= ${since}
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? "0");
}

export interface KybUploadRow {
  readonly id: string;
  readonly businessId: string | null;
  readonly purpose: string;
  readonly status: string;
  readonly mimeType: string;
  readonly objectKey: string;
}

export async function findUploads(context: DatabaseContext, uploadIds: readonly string[]): Promise<KybUploadRow[]> {
  if (uploadIds.length === 0) return [];
  const result = await sql<KybUploadRow>`
    select "id", "businessId", "purpose", "status", "mimeType", "objectKey" from app.uploads
    where "id" in (${sql.join(uploadIds.map((id) => sql`${id}::uuid`))})
  `.execute(context.transaction);
  return result.rows;
}

export async function listProfilesForReview(
  context: DatabaseContext,
  filter: { status: KycStatus; limit: number; offset: number },
): Promise<{ profiles: BankingProfileRow[]; totalCount: number }> {
  const [rows, count] = await Promise.all([
    sql<BankingProfileRow>`
      select ${sql.raw(PROFILE_COLUMNS)} from app.banking_profiles
      where "providerCustomerType" = 'business' and "kycStatus" = ${filter.status}
      order by "kycSubmittedAt" asc nulls last
      limit ${filter.limit} offset ${filter.offset}
    `.execute(context.transaction),
    sql<{ count: string }>`
      select count(*)::text as "count" from app.banking_profiles where "providerCustomerType" = 'business' and "kycStatus" = ${filter.status}
    `.execute(context.transaction),
  ]);
  return { profiles: rows.rows.map((row) => decryptProfile(row)!), totalCount: Number(count.rows[0]?.count ?? "0") };
}

/** Conditional on still being a pending business submission, so a concurrent decision (or a provider webhook) is never overwritten. */
export async function decideBusinessReview(
  context: DatabaseContext,
  businessId: string,
  fields: { status: "verified" | "failed"; reviewedBy: string; notes: string | null },
): Promise<BankingProfileRow | undefined> {
  const result = await sql<BankingProfileRow>`
    update app.banking_profiles set
      "kycStatus" = ${fields.status},
      "kycFailureReason" = case when ${fields.status} = 'failed' then ${fields.notes} else null end,
      "kycVerifiedAt" = case when ${fields.status} = 'verified' then now() else null end,
      "kybReviewedBy" = ${fields.reviewedBy}::uuid,
      "kybReviewedAt" = now(),
      "kybReviewNotes" = ${fields.notes},
      "updatedAt" = now()
    where "businessId" = ${businessId}::uuid and "providerCustomerType" = 'business' and "kycStatus" = 'pending'
    returning ${sql.raw(PROFILE_COLUMNS)}
  `.execute(context.transaction);
  return decryptProfile(result.rows[0]);
}

export async function findCurrentVirtualAccount(context: DatabaseContext, businessId: string): Promise<VirtualAccountRow | undefined> {
  const result = await sql<VirtualAccountRow>`
    select ${sql.raw(VIRTUAL_ACCOUNT_COLUMNS)} from app.virtual_accounts
    where "businessId" = ${businessId}::uuid and "status" in ('pending', 'active')
    order by "createdAt" desc limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createVirtualAccount(
  context: DatabaseContext,
  businessId: string,
  fields: {
    providerCustomerCode: string | null;
    providerAccountId: string | null;
    accountNumber: string | null;
    accountName: string | null;
    bankName: string | null;
    bankSlug: string | null;
    status: VirtualAccountStatus;
    assignmentReference: string | null;
    metadata: Record<string, unknown>;
  },
): Promise<VirtualAccountRow> {
  const result = await sql<VirtualAccountRow>`
    insert into app.virtual_accounts (
      "businessId", "providerCustomerCode", "providerAccountId", "accountNumber", "accountName", "bankName", "bankSlug", "status", "assignmentReference", "metadata"
    ) values (
      ${businessId}::uuid, ${fields.providerCustomerCode}, ${fields.providerAccountId}, ${fields.accountNumber}, ${fields.accountName},
      ${fields.bankName}, ${fields.bankSlug}, ${fields.status}, ${fields.assignmentReference}, ${JSON.stringify(fields.metadata)}::jsonb
    )
    returning ${sql.raw(VIRTUAL_ACCOUNT_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateVirtualAccount(
  context: DatabaseContext,
  id: string,
  fields: { status?: VirtualAccountStatus; failureReason?: string | null; lastRequeryAt?: Date },
): Promise<VirtualAccountRow | undefined> {
  const result = await sql<VirtualAccountRow>`
    update app.virtual_accounts set
      "status" = coalesce(${fields.status ?? null}, "status"),
      "failureReason" = case when ${fields.failureReason !== undefined} then ${fields.failureReason ?? null} else "failureReason" end,
      "lastRequeryAt" = coalesce(${fields.lastRequeryAt ?? null}, "lastRequeryAt"),
      "updatedAt" = now()
    where "id" = ${id}::uuid
    returning ${sql.raw(VIRTUAL_ACCOUNT_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listWalletTransactions(
  context: DatabaseContext,
  businessId: string,
  filter: ListWalletTransactionsFilter,
): Promise<{ transactions: WalletTransactionRow[]; totalCount: number }> {
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;

  const [rows, count] = await Promise.all([
    sql<WalletTransactionRow>`
      select ${sql.raw(WALLET_TRANSACTION_COLUMNS)} from app.wallet_transactions
      where "businessId" = ${businessId}::uuid
      order by "createdAt" desc
      limit ${limit} offset ${offset}
    `.execute(context.transaction),
    sql<{ count: string }>`select count(*)::text as "count" from app.wallet_transactions where "businessId" = ${businessId}::uuid`.execute(context.transaction),
  ]);

  return { transactions: rows.rows, totalCount: Number(count.rows[0]?.count ?? "0") };
}

/** Sum of credits minus debits across pending+posted entries — the same "available" semantics legacy uses. */
export async function getAvailableBalance(context: DatabaseContext, businessId: string): Promise<string> {
  const result = await sql<{ balance: string }>`
    select coalesce(sum(case when "direction" = 'credit' then "amountMinor" else -"amountMinor" end), 0)::text as "balance"
    from app.wallet_transactions
    where "businessId" = ${businessId}::uuid and "status" in ('pending', 'posted')
  `.execute(context.transaction);
  return result.rows[0]?.balance ?? "0";
}

/**
 * Idempotent on (provider, providerReference) — re-posting the same
 * provider event for a reference that already has a ledger row returns the
 * existing row instead of double-posting.
 */
export async function postWalletTransaction(
  context: DatabaseContext,
  businessId: string,
  fields: {
    type: WalletTransactionType;
    direction: WalletTransactionDirection;
    status: WalletTransactionStatus;
    assetCode: string;
    amountMinor: string;
    grossAmountMinor?: string | null;
    feeAmountMinor?: string;
    feeBreakdown?: Record<string, unknown>;
    provider: string;
    providerReference: string;
    description: string;
    metadata?: Record<string, unknown>;
  },
): Promise<WalletTransactionRow> {
  const inserted = await sql<WalletTransactionRow>`
    insert into app.wallet_transactions (
      "businessId", "type", "direction", "status", "assetCode", "amountMinor", "grossAmountMinor", "feeAmountMinor", "feeBreakdown", "provider", "providerReference", "description", "metadata", "postedAt"
    ) values (
      ${businessId}::uuid, ${fields.type}, ${fields.direction}, ${fields.status}, ${fields.assetCode}, ${fields.amountMinor}::bigint,
      ${fields.grossAmountMinor ?? null}::bigint, ${fields.feeAmountMinor ?? "0"}::bigint, ${JSON.stringify(fields.feeBreakdown ?? {})}::jsonb,
      ${fields.provider}, ${fields.providerReference}, ${fields.description}, ${JSON.stringify(fields.metadata ?? {})}::jsonb,
      ${fields.status === "posted" ? new Date() : null}
    )
    on conflict ("provider", "providerReference") do nothing
    returning ${sql.raw(WALLET_TRANSACTION_COLUMNS)}
  `.execute(context.transaction);
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await sql<WalletTransactionRow>`
    select ${sql.raw(WALLET_TRANSACTION_COLUMNS)} from app.wallet_transactions
    where "provider" = ${fields.provider} and "providerReference" = ${fields.providerReference}
  `.execute(context.transaction);
  return existing.rows[0]!;
}

export async function findWithdrawalByIdempotencyKey(context: DatabaseContext, businessId: string, idempotencyKey: string): Promise<WithdrawalRow | undefined> {
  const result = await sql<WithdrawalRow>`
    select ${sql.raw(WITHDRAWAL_COLUMNS)} from app.withdrawals
    where "businessId" = ${businessId}::uuid and "idempotencyKey" = ${idempotencyKey}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findWithdrawalByProviderReference(context: DatabaseContext, providerReference: string): Promise<WithdrawalRow | undefined> {
  const result = await sql<WithdrawalRow>`
    select ${sql.raw(WITHDRAWAL_COLUMNS)} from app.withdrawals where "providerReference" = ${providerReference}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findWithdrawalByTransferCode(context: DatabaseContext, businessId: string, transferCode: string): Promise<WithdrawalRow | undefined> {
  const result = await sql<WithdrawalRow>`
    select ${sql.raw(WITHDRAWAL_COLUMNS)} from app.withdrawals
    where "businessId" = ${businessId}::uuid and "providerTransferCode" = ${transferCode}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function markWalletTransactionPosted(context: DatabaseContext, provider: string, providerReference: string): Promise<void> {
  await sql`
    update app.wallet_transactions set "status" = 'posted', "postedAt" = now()
    where "provider" = ${provider} and "providerReference" = ${providerReference}
  `.execute(context.transaction);
}

export async function createWithdrawal(
  context: DatabaseContext,
  businessId: string,
  requestedBy: string,
  fields: {
    id?: string;
    amountMinor: string;
    assetCode: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    providerReference: string;
    idempotencyKey: string;
    status?: "pending" | "awaitingApproval";
  },
): Promise<WithdrawalRow> {
  const result = await sql<WithdrawalRow>`
    insert into app.withdrawals (
      "id", "businessId", "requestedBy", "amountMinor", "assetCode", "bankCode", "accountNumber", "accountName", "providerReference", "idempotencyKey", "status"
    ) values (
      coalesce(${fields.id ?? null}::uuid, gen_random_uuid()), ${businessId}::uuid, ${requestedBy}::uuid, ${fields.amountMinor}::bigint, ${fields.assetCode}, ${fields.bankCode},
      ${fields.accountNumber}, ${fields.accountName}, ${fields.providerReference}, ${fields.idempotencyKey}, ${fields.status ?? "pending"}
    )
    returning ${sql.raw(WITHDRAWAL_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateWithdrawal(
  context: DatabaseContext,
  id: string,
  fields: { status?: WithdrawalStatus; transferRecipientCode?: string; providerTransferCode?: string; failureReason?: string | null },
): Promise<WithdrawalRow | undefined> {
  const result = await sql<WithdrawalRow>`
    update app.withdrawals set
      "status" = coalesce(${fields.status ?? null}, "status"),
      "transferRecipientCode" = coalesce(${fields.transferRecipientCode ?? null}, "transferRecipientCode"),
      "providerTransferCode" = coalesce(${fields.providerTransferCode ?? null}, "providerTransferCode"),
      "failureReason" = case when ${fields.failureReason !== undefined} then ${fields.failureReason ?? null} else "failureReason" end,
      "updatedAt" = now()
    where "id" = ${id}::uuid
    returning ${sql.raw(WITHDRAWAL_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findWithdrawalById(context: DatabaseContext, businessId: string, id: string): Promise<WithdrawalRow | undefined> {
  const result = await sql<WithdrawalRow>`select ${sql.raw(WITHDRAWAL_COLUMNS)} from app.withdrawals where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid`.execute(context.transaction);
  return result.rows[0];
}

/**
 * Conditional claim for re-entrancy safety: only the caller that actually
 * transitions the row (0 rows back means someone else already claimed it)
 * may proceed to call the payment provider — mirrors legacy's
 * `UPDATE ... WHERE status = 'awaiting_approval'` claim in
 * executeBillTransfer, applied here to an approved withdrawal.
 */
export async function claimWithdrawalForProcessing(context: DatabaseContext, id: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.withdrawals set "status" = 'processing', "updatedAt" = now()
    where "id" = ${id}::uuid and "status" = 'awaitingApproval'
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}
