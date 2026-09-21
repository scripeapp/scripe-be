import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { JobAttemptRow, JobRow, JobStatus, ListJobsFilter, ScheduleJobInput } from "./jobs.types.js";

const JOB_COLUMNS = sql`
  "id", "type", "payload", "status", "runAt", "attempts", "maxAttempts", "lastError", "lockedBy", "lockedUntil", "createdAt", "updatedAt"
`;

/**
 * Not called by any route - other domains' service code calls this
 * directly, within their own transaction, to enqueue future work. No
 * RETURNING: app.jobs' SELECT policy is platform-admin-only, so a
 * non-admin caller's INSERT ... RETURNING would fail Postgres' RETURNING-
 * reselect check even though the insert itself is unrestricted - the same
 * issue platform/risk/communications hit, avoided here from the start.
 */
export async function scheduleJob(context: DatabaseContext, input: ScheduleJobInput): Promise<void> {
  await sql`
    insert into app.jobs ("type", "payload", "runAt", "maxAttempts")
    values (${input.type}, ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.runAt ?? new Date()}, ${input.maxAttempts ?? 5})
  `.execute(context.transaction);
}

export async function listJobs(context: DatabaseContext, filter: ListJobsFilter): Promise<{ rows: JobRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (filter.type) clauses.push(sql`"type" = ${filter.type}`);
  if (filter.status) clauses.push(sql`"status" = ${filter.status}`);
  const limit = filter.limit ?? 25;
  const offset = ((filter.page ?? 1) - 1) * limit;

  const result = await sql<JobRow & { totalCount: string }>`
    select ${JOB_COLUMNS}, count(*) over ()::text as "totalCount"
    from app.jobs
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);
  return { rows: result.rows, total: Number(result.rows[0]?.totalCount ?? "0") };
}

export async function findJob(context: DatabaseContext, jobId: string): Promise<JobRow | undefined> {
  const result = await sql<JobRow>`select ${JOB_COLUMNS} from app.jobs where "id" = ${jobId}::uuid`.execute(context.transaction);
  return result.rows[0];
}

export async function listAttemptsForJob(context: DatabaseContext, jobId: string): Promise<JobAttemptRow[]> {
  const result = await sql<JobAttemptRow>`
    select "id", "jobId", "attemptNumber", "status", "error", "startedAt", "finishedAt"
    from app.job_attempts where "jobId" = ${jobId}::uuid order by "attemptNumber" desc
  `.execute(context.transaction);
  return result.rows;
}

/** Admin manual control: re-run a terminal (failed/cancelled) job immediately, or cancel a pending one. */
export async function setJobStatus(context: DatabaseContext, jobId: string, status: Extract<JobStatus, "pending" | "cancelled">, runAt?: Date): Promise<JobRow | undefined> {
  const fields: RawBuilder<unknown>[] = [sql`"status" = ${status}`];
  if (runAt) fields.push(sql`"runAt" = ${runAt}`);
  if (status === "pending") fields.push(sql`"attempts" = 0`, sql`"lastError" = null`);

  const result = await sql<JobRow>`
    update app.jobs set ${sql.join(fields, sql`, `)}
    where "id" = ${jobId}::uuid
    returning ${JOB_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

// ---------------------------------------------------------------------
// Poller-only functions - called from the in-process scheduler, which has
// no request-scoped caller identity, hence the security-definer functions
// rather than plain RLS-gated statements.
// ---------------------------------------------------------------------

export async function claimDueJobs(context: DatabaseContext, limit: number, leaseSeconds: number, worker: string): Promise<JobRow[]> {
  const result = await sql<JobRow>`
    select ${JOB_COLUMNS} from app.claim_due_jobs(${limit}, ${leaseSeconds}, ${worker})
  `.execute(context.transaction);
  return result.rows;
}

export async function finishJob(context: DatabaseContext, jobId: string, succeeded: boolean, error: string | null, nextRunAt: Date | null): Promise<void> {
  await sql`select app.finish_job(${jobId}::uuid, ${succeeded}, ${error}, ${nextRunAt})`.execute(context.transaction);
}

/** Idempotent bootstrap for a built-in recurring job - see app.ensure_recurring_job's comment for why this needs the security-definer bypass rather than a plain check-then-insert. */
export async function ensureRecurringJob(context: DatabaseContext, type: string, maxAttempts: number): Promise<void> {
  await sql`select app.ensure_recurring_job(${type}, ${maxAttempts})`.execute(context.transaction);
}
