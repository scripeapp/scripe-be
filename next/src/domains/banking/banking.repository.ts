import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  BankingProfileRow,
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

const PROFILE_COLUMNS = `"businessId", "kycStatus", "kycFailureReason", "kycSubmittedAt", "kycVerifiedAt", "providerCustomerCode", "email", "firstName", "lastName", "phone", "bvn", "createdAt", "updatedAt"`;
const VIRTUAL_ACCOUNT_COLUMNS = `"id", "businessId", "provider", "providerCustomerCode", "providerAccountId", "accountNumber", "accountName", "bankName", "bankSlug", "assetCode", "status", "assignmentReference", "failureReason", "metadata", "lastRequeryAt", "createdAt", "updatedAt"`;
const WALLET_TRANSACTION_COLUMNS = `"id", "businessId", "type", "direction", "status", "assetCode", "amountMinor", "grossAmountMinor", "feeAmountMinor", "feeBreakdown", "provider", "providerReference", "description", "metadata", "postedAt", "createdAt"`;
const WITHDRAWAL_COLUMNS = `"id", "businessId", "requestedBy", "amountMinor", "assetCode", "bankCode", "accountNumber", "accountName", "transferRecipientCode", "providerReference", "providerTransferCode", "idempotencyKey", "status", "failureReason", "createdAt", "updatedAt"`;

export async function findProfile(context: DatabaseContext, businessId: string): Promise<BankingProfileRow | undefined> {
  const result = await sql<BankingProfileRow>`
    select ${sql.raw(PROFILE_COLUMNS)} from app.banking_profiles where "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function upsertProfile(
  context: DatabaseContext,
  businessId: string,
  fields: {
    kycStatus: KycStatus;
    kycFailureReason?: string | null;
    kycSubmittedAt?: Date | null;
    kycVerifiedAt?: Date | null;
    providerCustomerCode?: string | null;
    email?: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    bvn?: string;
  },
): Promise<BankingProfileRow> {
  const result = await sql<BankingProfileRow>`
    insert into app.banking_profiles ("businessId", "kycStatus", "kycFailureReason", "kycSubmittedAt", "kycVerifiedAt", "providerCustomerCode", "email", "firstName", "lastName", "phone", "bvn")
    values (
      ${businessId}::uuid, ${fields.kycStatus}, ${fields.kycFailureReason ?? null}, ${fields.kycSubmittedAt ?? null}, ${fields.kycVerifiedAt ?? null},
      ${fields.providerCustomerCode ?? null}, ${fields.email ?? null}, ${fields.firstName ?? null}, ${fields.lastName ?? null}, ${fields.phone ?? null}, ${fields.bvn ?? null}
    )
    on conflict ("businessId") do update set
      "kycStatus" = excluded."kycStatus",
      "kycFailureReason" = excluded."kycFailureReason",
      "kycSubmittedAt" = coalesce(excluded."kycSubmittedAt", app.banking_profiles."kycSubmittedAt"),
      "kycVerifiedAt" = excluded."kycVerifiedAt",
      "providerCustomerCode" = coalesce(excluded."providerCustomerCode", app.banking_profiles."providerCustomerCode"),
      "email" = coalesce(excluded."email", app.banking_profiles."email"),
      "firstName" = coalesce(excluded."firstName", app.banking_profiles."firstName"),
      "lastName" = coalesce(excluded."lastName", app.banking_profiles."lastName"),
      "phone" = coalesce(excluded."phone", app.banking_profiles."phone"),
      "bvn" = coalesce(excluded."bvn", app.banking_profiles."bvn"),
      "updatedAt" = now()
    returning ${sql.raw(PROFILE_COLUMNS)}
  `.execute(context.transaction);
  return result.rows[0]!;
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
    amountMinor: string;
    assetCode: string;
    bankCode: string;
    accountNumber: string;
    accountName: string;
    providerReference: string;
    idempotencyKey: string;
  },
): Promise<WithdrawalRow> {
  const result = await sql<WithdrawalRow>`
    insert into app.withdrawals (
      "businessId", "requestedBy", "amountMinor", "assetCode", "bankCode", "accountNumber", "accountName", "providerReference", "idempotencyKey"
    ) values (
      ${businessId}::uuid, ${requestedBy}::uuid, ${fields.amountMinor}::bigint, ${fields.assetCode}, ${fields.bankCode},
      ${fields.accountNumber}, ${fields.accountName}, ${fields.providerReference}, ${fields.idempotencyKey}
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
