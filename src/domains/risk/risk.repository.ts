import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  CreateCaseInput,
  CreateHoldInput,
  HoldEntityType,
  ListSignalsFilter,
  RecordSignalInput,
  ReviewSignalInput,
  RiskCaseRow,
  RiskSignalRow,
  RiskStats,
  TransactionHoldRow,
  UpdateCaseInput,
} from "./risk.types.js";

const SIGNAL_COLUMNS = sql`
  "id", "entityType", "entityId", "signalType", "description", "severity", "status", "metadata",
  "riskCaseId", "reviewedBy", "reviewNotes", "reviewedAt", "createdAt"
`;

/**
 * Not called by any route - other domains' service code calls this
 * directly, within their own transaction, to raise a signal. No RETURNING:
 * this table's SELECT policy is platform-admin-only, so a non-admin
 * caller's INSERT ... RETURNING would fail Postgres' RETURNING-reselect
 * check even though the insert itself is unrestricted - the same class of
 * issue the platform/audit domains hit, avoided here by never asking for
 * the row back, matching legacy's original fire-and-forget shape anyway.
 */
export async function recordSignal(context: DatabaseContext, input: RecordSignalInput): Promise<void> {
  await sql`
    insert into app.risk_signals ("entityType", "entityId", "signalType", "description", "severity", "metadata")
    values (${input.entityType}, ${input.entityId}::uuid, ${input.signalType}, ${input.description}, ${input.severity}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
  `.execute(context.transaction);
}

export async function listSignals(context: DatabaseContext, filter: ListSignalsFilter): Promise<{ rows: RiskSignalRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (filter.status) clauses.push(sql`"status" = ${filter.status}`);
  if (filter.severity) clauses.push(sql`"severity" = ${filter.severity}`);
  if (filter.entityType) clauses.push(sql`"entityType" = ${filter.entityType}`);
  if (filter.from) clauses.push(sql`"createdAt" >= ${filter.from}::timestamptz`);
  if (filter.to) clauses.push(sql`"createdAt" <= ${filter.to}::timestamptz`);
  const limit = filter.limit ?? 25;
  const offset = ((filter.page ?? 1) - 1) * limit;

  const result = await sql<RiskSignalRow & { totalCount: string }>`
    select ${SIGNAL_COLUMNS}, count(*) over ()::text as "totalCount"
    from app.risk_signals
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);
  return { rows: result.rows, total: Number(result.rows[0]?.totalCount ?? "0") };
}

export async function findSignal(context: DatabaseContext, signalId: string): Promise<RiskSignalRow | undefined> {
  const result = await sql<RiskSignalRow>`select ${SIGNAL_COLUMNS} from app.risk_signals where "id" = ${signalId}::uuid`.execute(context.transaction);
  return result.rows[0];
}

export async function reviewSignal(context: DatabaseContext, signalId: string, reviewedBy: string, input: ReviewSignalInput): Promise<RiskSignalRow | undefined> {
  const result = await sql<RiskSignalRow>`
    update app.risk_signals set "status" = ${input.status}, "reviewedBy" = ${reviewedBy}::uuid, "reviewNotes" = ${input.notes ?? null}, "reviewedAt" = now()
    where "id" = ${signalId}::uuid
    returning ${SIGNAL_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function assignSignalsToCase(context: DatabaseContext, caseId: string, signalIds: readonly string[]): Promise<void> {
  if (signalIds.length === 0) return;
  await sql`
    update app.risk_signals set "riskCaseId" = ${caseId}::uuid
    where "id" = any(${signalIds}::uuid[])
  `.execute(context.transaction);
}

export async function listSignalsForCase(context: DatabaseContext, caseId: string): Promise<RiskSignalRow[]> {
  const result = await sql<RiskSignalRow>`select ${SIGNAL_COLUMNS} from app.risk_signals where "riskCaseId" = ${caseId}::uuid order by "createdAt" desc`.execute(context.transaction);
  return result.rows;
}

export async function getStats(context: DatabaseContext): Promise<RiskStats> {
  const result = await sql<RiskStats>`
    select
      count(*) filter (where "status" = 'open')::int as "open",
      count(*) filter (where "status" = 'investigating')::int as "investigating",
      count(*) filter (where "status" = 'confirmed')::int as "confirmed",
      count(*) filter (where "status" = 'open' and "severity" = 'critical')::int as "criticalOpen",
      count(*) filter (where "status" = 'open' and "severity" = 'high')::int as "highOpen"
    from app.risk_signals
  `.execute(context.transaction);
  return result.rows[0]!;
}

const CASE_COLUMNS = sql`"id", "title", "status", "assignedTo", "resolutionNotes", "createdBy", "createdAt", "updatedAt", "resolvedAt"`;

export async function listCases(context: DatabaseContext, status: string | undefined): Promise<RiskCaseRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (status) clauses.push(sql`"status" = ${status}`);
  const result = await sql<RiskCaseRow>`
    select ${CASE_COLUMNS} from app.risk_cases where ${sql.join(clauses, sql` and `)} order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findCase(context: DatabaseContext, caseId: string): Promise<RiskCaseRow | undefined> {
  const result = await sql<RiskCaseRow>`select ${CASE_COLUMNS} from app.risk_cases where "id" = ${caseId}::uuid`.execute(context.transaction);
  return result.rows[0];
}

export async function createCase(context: DatabaseContext, createdBy: string, input: CreateCaseInput): Promise<RiskCaseRow> {
  const result = await sql<RiskCaseRow>`
    insert into app.risk_cases ("title", "createdBy") values (${input.title}, ${createdBy}::uuid)
    returning ${CASE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateCase(context: DatabaseContext, caseId: string, input: UpdateCaseInput): Promise<RiskCaseRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.status !== undefined) {
    fields.push(sql`"status" = ${input.status}`);
    fields.push(sql`"resolvedAt" = case when ${input.status} in ('resolved', 'dismissed') then now() else "resolvedAt" end`);
  }
  if (input.assignedTo !== undefined) fields.push(sql`"assignedTo" = ${input.assignedTo}::uuid`);
  if (input.resolutionNotes !== undefined) fields.push(sql`"resolutionNotes" = ${input.resolutionNotes}`);
  if (fields.length === 0) return findCase(context, caseId);

  const result = await sql<RiskCaseRow>`
    update app.risk_cases set ${sql.join(fields, sql`, `)} where "id" = ${caseId}::uuid
    returning ${CASE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

const HOLD_COLUMNS = sql`"id", "entityType", "entityId", "reason", "status", "createdBy", "releasedBy", "releasedAt", "createdAt"`;

export async function listHolds(context: DatabaseContext, status: string | undefined): Promise<TransactionHoldRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (status) clauses.push(sql`"status" = ${status}`);
  const result = await sql<TransactionHoldRow>`
    select ${HOLD_COLUMNS} from app.transaction_holds where ${sql.join(clauses, sql` and `)} order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findHold(context: DatabaseContext, holdId: string): Promise<TransactionHoldRow | undefined> {
  const result = await sql<TransactionHoldRow>`select ${HOLD_COLUMNS} from app.transaction_holds where "id" = ${holdId}::uuid`.execute(context.transaction);
  return result.rows[0];
}

export async function createHold(context: DatabaseContext, createdBy: string, input: CreateHoldInput): Promise<TransactionHoldRow> {
  const result = await sql<TransactionHoldRow>`
    insert into app.transaction_holds ("entityType", "entityId", "reason", "createdBy")
    values (${input.entityType}, ${input.entityId}::uuid, ${input.reason}, ${createdBy}::uuid)
    returning ${HOLD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function releaseHold(context: DatabaseContext, holdId: string, releasedBy: string): Promise<TransactionHoldRow | undefined> {
  const result = await sql<TransactionHoldRow>`
    update app.transaction_holds set "status" = 'released', "releasedBy" = ${releasedBy}::uuid, "releasedAt" = now()
    where "id" = ${holdId}::uuid and "status" = 'active'
    returning ${HOLD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

/**
 * Called by other domains (e.g. banking's withdrawal gate) to check for an
 * active hold without needing direct table access - a security-definer
 * predicate, the same shape as has_business_permission.
 */
export async function hasActiveHold(context: DatabaseContext, entityType: HoldEntityType, entityId: string): Promise<boolean> {
  const result = await sql<{ hasActiveTransactionHold: boolean }>`
    select app.has_active_transaction_hold(${entityType}, ${entityId}::uuid) as "hasActiveTransactionHold"
  `.execute(context.transaction);
  return result.rows[0]?.hasActiveTransactionHold ?? false;
}
