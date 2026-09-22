/**
 * Database access for the transfers domain. Every function accepts a
 * DatabaseContext and runs on its request-scoped transaction; none imports the
 * global pool. Provider identity is written to transfer_attempts only.
 */
import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  BeneficiaryKind,
  BeneficiaryRow,
  TransferAttemptRow,
  TransferAttemptStatus,
  TransferPurpose,
  TransferRow,
  TransferStatus,
} from "./transfers.types.js";

const BENEFICIARY_COLUMNS = sql`"id", "businessId", "partyId", "kind", "bankCode", "accountNumber", "accountName", "status", "createdAt", "updatedAt"`;
const TRANSFER_COLUMNS = sql`"id", "businessId", "beneficiaryId", "amountMinor"::text as "amountMinor", "assetCode", "purpose", "status", "reference", "idempotencyKey", "journalEntryId", "approvalRequestId", "requestedBy", "failureReason", "createdAt", "updatedAt"`;
const ATTEMPT_COLUMNS = sql`"id", "transferId", "businessId", "provider", "providerRecipientCode", "providerTransferCode", "providerReference", "status", "failureReason", "createdAt", "updatedAt"`;

// --- Beneficiaries ---

export async function insertBeneficiary(
  context: DatabaseContext,
  businessId: string,
  input: { kind: BeneficiaryKind; bankCode: string; accountNumber: string; accountName: string; partyId: string | null },
): Promise<BeneficiaryRow> {
  const result = await sql<BeneficiaryRow>`
    insert into app.beneficiaries ("businessId", "partyId", "kind", "bankCode", "accountNumber", "accountName")
    values (${businessId}::uuid, ${input.partyId}::uuid, ${input.kind}, ${input.bankCode}, ${input.accountNumber}, ${input.accountName})
    returning ${BENEFICIARY_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function findBeneficiaryByCoordinates(
  context: DatabaseContext,
  businessId: string,
  bankCode: string,
  accountNumber: string,
): Promise<BeneficiaryRow | undefined> {
  const result = await sql<BeneficiaryRow>`
    select ${BENEFICIARY_COLUMNS} from app.beneficiaries
    where "businessId" = ${businessId}::uuid and "bankCode" = ${bankCode} and "accountNumber" = ${accountNumber}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findBeneficiary(context: DatabaseContext, businessId: string, beneficiaryId: string): Promise<BeneficiaryRow | undefined> {
  const result = await sql<BeneficiaryRow>`
    select ${BENEFICIARY_COLUMNS} from app.beneficiaries
    where "businessId" = ${businessId}::uuid and "id" = ${beneficiaryId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listBeneficiaries(context: DatabaseContext, businessId: string): Promise<BeneficiaryRow[]> {
  const result = await sql<BeneficiaryRow>`
    select ${BENEFICIARY_COLUMNS} from app.beneficiaries
    where "businessId" = ${businessId}::uuid order by "status", "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function setBeneficiaryStatus(
  context: DatabaseContext,
  businessId: string,
  beneficiaryId: string,
  status: BeneficiaryRow["status"],
): Promise<BeneficiaryRow | undefined> {
  const result = await sql<BeneficiaryRow>`
    update app.beneficiaries set "status" = ${status}
    where "businessId" = ${businessId}::uuid and "id" = ${beneficiaryId}::uuid
    returning ${BENEFICIARY_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

// --- Transfers ---

export async function findTransferByIdempotencyKey(context: DatabaseContext, businessId: string, idempotencyKey: string): Promise<TransferRow | undefined> {
  const result = await sql<TransferRow>`
    select ${TRANSFER_COLUMNS} from app.transfers
    where "businessId" = ${businessId}::uuid and "idempotencyKey" = ${idempotencyKey}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function insertTransfer(
  context: DatabaseContext,
  businessId: string,
  userId: string | null,
  input: {
    id: string;
    beneficiaryId: string;
    amountMinor: string;
    assetCode: string;
    purpose: TransferPurpose;
    status: TransferStatus;
    reference: string;
    idempotencyKey: string;
    approvalRequestId: string | null;
    requestId: string;
  },
): Promise<TransferRow> {
  const result = await sql<TransferRow>`
    insert into app.transfers
      ("id", "businessId", "beneficiaryId", "amountMinor", "assetCode", "purpose", "status", "reference", "idempotencyKey", "approvalRequestId", "requestedBy", "requestId")
    values
      (${input.id}::uuid, ${businessId}::uuid, ${input.beneficiaryId}::uuid, ${input.amountMinor}::bigint, ${input.assetCode}, ${input.purpose},
       ${input.status}, ${input.reference}, ${input.idempotencyKey}, ${input.approvalRequestId}::uuid, ${userId}::uuid, ${input.requestId})
    returning ${TRANSFER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function findTransfer(context: DatabaseContext, businessId: string, transferId: string): Promise<TransferRow | undefined> {
  const result = await sql<TransferRow>`
    select ${TRANSFER_COLUMNS} from app.transfers
    where "businessId" = ${businessId}::uuid and "id" = ${transferId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listTransfers(context: DatabaseContext, businessId: string, status: TransferStatus | undefined, limit: number): Promise<TransferRow[]> {
  const result = await sql<TransferRow>`
    select ${TRANSFER_COLUMNS} from app.transfers
    where "businessId" = ${businessId}::uuid ${status ? sql`and "status" = ${status}` : sql``}
    order by "createdAt" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function updateTransfer(
  context: DatabaseContext,
  businessId: string,
  transferId: string,
  patch: { status?: TransferStatus; failureReason?: string | null; journalEntryId?: string },
): Promise<TransferRow | undefined> {
  const result = await sql<TransferRow>`
    update app.transfers set
      "status" = coalesce(${patch.status ?? null}, "status"),
      "failureReason" = case when ${patch.failureReason !== undefined} then ${patch.failureReason ?? null} else "failureReason" end,
      "journalEntryId" = coalesce(${patch.journalEntryId ?? null}::uuid, "journalEntryId")
    where "businessId" = ${businessId}::uuid and "id" = ${transferId}::uuid
    returning ${TRANSFER_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

// --- Transfer attempts ---

export async function insertAttempt(
  context: DatabaseContext,
  businessId: string,
  input: {
    transferId: string;
    provider: string;
    providerReference: string;
    providerRecipientCode: string | null;
    providerTransferCode: string | null;
    status: TransferAttemptStatus;
    failureReason: string | null;
    rawResult: unknown;
  },
): Promise<TransferAttemptRow> {
  const result = await sql<TransferAttemptRow>`
    insert into app.transfer_attempts
      ("transferId", "businessId", "provider", "providerReference", "providerRecipientCode", "providerTransferCode", "status", "failureReason", "rawResult")
    values
      (${input.transferId}::uuid, ${businessId}::uuid, ${input.provider}, ${input.providerReference}, ${input.providerRecipientCode},
       ${input.providerTransferCode}, ${input.status}, ${input.failureReason}, ${JSON.stringify(input.rawResult ?? null)}::jsonb)
    returning ${ATTEMPT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function listAttempts(context: DatabaseContext, businessId: string, transferId: string): Promise<TransferAttemptRow[]> {
  const result = await sql<TransferAttemptRow>`
    select ${ATTEMPT_COLUMNS} from app.transfer_attempts
    where "businessId" = ${businessId}::uuid and "transferId" = ${transferId}::uuid
    order by "createdAt"
  `.execute(context.transaction);
  return result.rows;
}
