/**
 * Database access for the payroll domain. Every function accepts a
 * DatabaseContext and runs on its request-scoped transaction.
 */
import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { PayrollItemRow, PayrollItemStatus, PayrollRunRow, PayrollRunStatus } from "./payroll.types.js";

const RUN_COLUMNS = sql`"id", "businessId", "reference", "periodStart"::text as "periodStart", "periodEnd"::text as "periodEnd", "status", "assetCode",
  "grossMinor"::text as "grossMinor", "deductionsMinor"::text as "deductionsMinor", "netMinor"::text as "netMinor",
  "journalEntryId", "approvedBy", "approvedAt", "createdBy", "createdAt", "updatedAt"`;
const ITEM_COLUMNS = sql`"id", "payrollRunId", "businessId", "beneficiaryId", "partyId",
  "grossMinor"::text as "grossMinor", "deductionsMinor"::text as "deductionsMinor", "netMinor"::text as "netMinor",
  "transferId", "status", "createdAt", "updatedAt"`;

export async function insertRun(
  context: DatabaseContext,
  businessId: string,
  userId: string | null,
  input: { id: string; reference: string; periodStart: string; periodEnd: string; grossMinor: string; deductionsMinor: string; netMinor: string },
): Promise<PayrollRunRow> {
  const result = await sql<PayrollRunRow>`
    insert into app.payroll_runs
      ("id", "businessId", "reference", "periodStart", "periodEnd", "grossMinor", "deductionsMinor", "netMinor", "createdBy")
    values
      (${input.id}::uuid, ${businessId}::uuid, ${input.reference}, ${input.periodStart}::date, ${input.periodEnd}::date,
       ${input.grossMinor}::bigint, ${input.deductionsMinor}::bigint, ${input.netMinor}::bigint, ${userId}::uuid)
    returning ${RUN_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function insertItem(
  context: DatabaseContext,
  businessId: string,
  input: { payrollRunId: string; beneficiaryId: string; partyId: string | null; grossMinor: string; deductionsMinor: string; netMinor: string },
): Promise<PayrollItemRow> {
  const result = await sql<PayrollItemRow>`
    insert into app.payroll_items
      ("payrollRunId", "businessId", "beneficiaryId", "partyId", "grossMinor", "deductionsMinor", "netMinor")
    values
      (${input.payrollRunId}::uuid, ${businessId}::uuid, ${input.beneficiaryId}::uuid, ${input.partyId}::uuid,
       ${input.grossMinor}::bigint, ${input.deductionsMinor}::bigint, ${input.netMinor}::bigint)
    returning ${ITEM_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function findRun(context: DatabaseContext, businessId: string, runId: string): Promise<PayrollRunRow | undefined> {
  const result = await sql<PayrollRunRow>`
    select ${RUN_COLUMNS} from app.payroll_runs where "businessId" = ${businessId}::uuid and "id" = ${runId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listRuns(context: DatabaseContext, businessId: string, status: PayrollRunStatus | undefined, limit: number): Promise<PayrollRunRow[]> {
  const result = await sql<PayrollRunRow>`
    select ${RUN_COLUMNS} from app.payroll_runs
    where "businessId" = ${businessId}::uuid ${status ? sql`and "status" = ${status}` : sql``}
    order by "createdAt" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function listItems(context: DatabaseContext, businessId: string, runId: string): Promise<PayrollItemRow[]> {
  const result = await sql<PayrollItemRow>`
    select ${ITEM_COLUMNS} from app.payroll_items
    where "businessId" = ${businessId}::uuid and "payrollRunId" = ${runId}::uuid order by "createdAt"
  `.execute(context.transaction);
  return result.rows;
}

export async function updateRun(
  context: DatabaseContext,
  businessId: string,
  runId: string,
  patch: { status?: PayrollRunStatus; approvedBy?: string; approvedAt?: Date; journalEntryId?: string },
): Promise<PayrollRunRow | undefined> {
  const result = await sql<PayrollRunRow>`
    update app.payroll_runs set
      "status" = coalesce(${patch.status ?? null}, "status"),
      "approvedBy" = coalesce(${patch.approvedBy ?? null}::uuid, "approvedBy"),
      "approvedAt" = coalesce(${patch.approvedAt ?? null}::timestamptz, "approvedAt"),
      "journalEntryId" = coalesce(${patch.journalEntryId ?? null}::uuid, "journalEntryId")
    where "businessId" = ${businessId}::uuid and "id" = ${runId}::uuid
    returning ${RUN_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function updateItem(
  context: DatabaseContext,
  businessId: string,
  itemId: string,
  patch: { status?: PayrollItemStatus; transferId?: string },
): Promise<void> {
  await sql`
    update app.payroll_items set
      "status" = coalesce(${patch.status ?? null}, "status"),
      "transferId" = coalesce(${patch.transferId ?? null}::uuid, "transferId")
    where "businessId" = ${businessId}::uuid and "id" = ${itemId}::uuid
  `.execute(context.transaction);
}
