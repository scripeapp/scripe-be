import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal } from "../../db/principal.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError } from "../../shared/errors.js";
import { requirePlatformAdministrator } from "../platform/platform.service.js";
import * as repository from "./jobs.repository.js";
import type { Job, JobAttempt, JobAttemptRow, JobHandler, JobRow, JobsOperation, JobsPage, ListJobsFilter, ScheduleJobInput } from "./jobs.types.js";

export class JobsService {
  constructor(private readonly database: Database) {}

  async listJobs(operation: JobsOperation, filter: ListJobsFilter): Promise<JobsPage> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      const { rows, total } = await repository.listJobs(context, filter);
      return { data: rows.map(toJob), total };
    });
  }

  async getJob(operation: JobsOperation, jobId: string): Promise<{ job: Job; attempts: JobAttempt[] }> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      const found = await repository.findJob(context, jobId);
      if (!found) throw notFoundError("Job not found");
      const attempts = await repository.listAttemptsForJob(context, jobId);
      return { job: toJob(found), attempts: attempts.map(toAttempt) };
    });
  }

  /** Admin manual control, matching legacy's admin "run cron now" button. */
  async rerunJob(operation: JobsOperation, jobId: string): Promise<Job> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const existing = await repository.findJob(context, jobId);
      if (!existing) throw notFoundError("Job not found");
      if (existing.status === "running") throw conflictError("This job is currently running");
      const updated = await repository.setJobStatus(context, jobId, "pending", new Date());
      return toJob(updated!);
    });
  }

  async cancelJob(operation: JobsOperation, jobId: string): Promise<Job> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const existing = await repository.findJob(context, jobId);
      if (!existing) throw notFoundError("Job not found");
      if (existing.status !== "pending") throw conflictError("Only a pending job can be cancelled");
      const updated = await repository.setJobStatus(context, jobId, "cancelled");
      return toJob(updated!);
    });
  }

  private async run<T>(operation: JobsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * Reusable by any domain's service code to enqueue future work within its
 * own transaction - the same "exported standalone function" shape as
 * risk's recordSignal/hasActiveHold and platform's requirePlatformAdministrator.
 */
export async function scheduleJob(context: DatabaseContext, input: ScheduleJobInput): Promise<void> {
  await repository.scheduleJob(context, input);
}

/**
 * In-process poller - registered from server.ts (never from app.ts, so it
 * never runs under the test harness, which only ever calls createApp()).
 * Claims due jobs in a short transaction, runs each handler outside any
 * transaction (handlers do their own DB work, and legacy's own webhook/
 * external-call lesson applies equally here - never hold a transaction
 * open across arbitrary handler logic), then records the result in a
 * second short transaction.
 */
export class JobScheduler {
  private readonly handlers = new Map<string, JobHandler>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking = false;

  constructor(
    private readonly database: Database,
    private readonly options: { pollIntervalMs?: number; batchSize?: number; leaseSeconds?: number; worker?: string } = {},
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  start(): void {
    if (this.timer) return;
    const intervalMs = this.options.pollIntervalMs ?? 60_000;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const claimed = await withDatabaseContext(this.database, anonymousPrincipal("job-scheduler"), (context) =>
        repository.claimDueJobs(context, this.options.batchSize ?? 10, this.options.leaseSeconds ?? 300, this.options.worker ?? "in-process"),
      );

      for (const job of claimed) {
        await this.runOne(job);
      }
    } catch (error) {
      console.error("[jobs] scheduler tick failed", error);
    } finally {
      this.ticking = false;
    }
  }

  private async runOne(job: JobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    if (!handler) {
      await this.finish(job.id, false, `No handler registered for job type "${job.type}"`, null);
      return;
    }

    try {
      const result = await handler(job.payload);
      await this.finish(job.id, true, null, result?.rescheduleAt ?? null);
    } catch (error) {
      await this.finish(job.id, false, error instanceof Error ? error.message : String(error), null);
    }
  }

  private async finish(jobId: string, succeeded: boolean, error: string | null, nextRunAt: Date | null): Promise<void> {
    await withDatabaseContext(this.database, anonymousPrincipal("job-scheduler"), (context) => repository.finishJob(context, jobId, succeeded, error, nextRunAt));
  }
}

function toJob(row: JobRow): Job {
  return { ...row, runAt: row.runAt.toISOString(), lockedUntil: row.lockedUntil?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

function toAttempt(row: JobAttemptRow): JobAttempt {
  return { ...row, startedAt: row.startedAt.toISOString(), finishedAt: row.finishedAt.toISOString() };
}
