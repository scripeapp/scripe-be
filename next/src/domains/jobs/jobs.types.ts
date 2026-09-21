/**
 * API and domain types for the background and scheduled work execution
 * domain. Database row types remain generated and separate.
 * Platform-staff-facing (observability/manual control), not business-scoped.
 */

export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRow {
  readonly id: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  readonly status: JobStatus;
  readonly runAt: Date;
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastError: string | null;
  readonly lockedBy: string | null;
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface Job extends Omit<JobRow, "runAt" | "lockedUntil" | "createdAt" | "updatedAt"> {
  readonly runAt: string;
  readonly lockedUntil: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobAttemptRow {
  readonly id: string;
  readonly jobId: string;
  readonly attemptNumber: number;
  readonly status: "succeeded" | "failed";
  readonly error: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface JobAttempt extends Omit<JobAttemptRow, "startedAt" | "finishedAt"> {
  readonly startedAt: string;
  readonly finishedAt: string;
}

export interface ListJobsFilter {
  readonly type?: string;
  readonly status?: JobStatus;
  readonly page?: number;
  readonly limit?: number;
}

export interface JobsPage {
  readonly data: Job[];
  readonly total: number;
}

/**
 * Not exposed via any route - other domains' server-side code calls this
 * directly, within their own transaction, to enqueue future work. Mirrors
 * the audit/admin_alerts/risk_signals server-only creation shape.
 */
export interface ScheduleJobInput {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
  readonly runAt?: Date;
  readonly maxAttempts?: number;
}

export interface JobsOperation {
  readonly userId: string;
  readonly requestId: string;
}

/**
 * A handler registered for a job `type`. Returning `{ rescheduleAt }` makes
 * the job self-perpetuating (the recurring-sweep shape, e.g. the upload
 * cleanup task); returning nothing/void completes it once. Throwing fails
 * the attempt and lets finish_job's backoff/maxAttempts logic decide
 * whether to retry.
 */
export type JobHandler = (payload: Record<string, unknown>) => Promise<{ rescheduleAt?: Date } | void>;
