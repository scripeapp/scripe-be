import { withDatabaseContext } from "../../db/database-context.js";
import type { Database } from "../../db/database.types.js";
import { anonymousPrincipal } from "../../db/principal.js";
import { runDunningSweep } from "../subscriptions/subscriptions.service.js";
import * as uploadsRepository from "../uploads/uploads.repository.js";
import * as repository from "./jobs.repository.js";
import type { JobScheduler } from "./jobs.service.js";

const UPLOAD_EXPIRY_JOB_TYPE = "uploads.expire_stale_pending";
const STALE_UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;
const RESCHEDULE_INTERVAL_MS = 60 * 60 * 1000;

const DUNNING_CHECK_JOB_TYPE = "subscriptions.dunning_check";
const DUNNING_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The one concrete task this slice ships: sweeps app.uploads for rows left
 * "pending" (the client never called confirm) past the TTL and marks them
 * failed - app.uploads_pending_idx's own comment (0026) named this exact
 * future job, and rules.md section E states it outright: "Orphan cleanup
 * runs as the worker role." Self-reschedules hourly on success, the
 * recurring-sweep shape built on top of the one-shot job primitive.
 */
function expireStalePendingUploadsHandler(database: Database) {
  return async (): Promise<{ rescheduleAt: Date }> => {
    const expiredCount = await withDatabaseContext(database, anonymousPrincipal("job-scheduler"), (context) =>
      uploadsRepository.expireStalePendingUploads(context, new Date(Date.now() - STALE_UPLOAD_TTL_MS)),
    );
    if (expiredCount > 0) console.log(`[jobs] expired ${expiredCount} stale pending upload(s)`);
    return { rescheduleAt: new Date(Date.now() + RESCHEDULE_INTERVAL_MS) };
  };
}

/**
 * Daily dunning sweep: reminds and eventually expires businesses whose
 * Scripe subscription payment failed, per subscriptions.service.ts's
 * runDunningSweep. This is legacy's invoice.payment_failed handler's bare
 * "TODO: Send notification email to business owner" actually built - see
 * that function's own comment for the full history.
 */
function dunningCheckHandler(database: Database) {
  return async (): Promise<{ rescheduleAt: Date }> => {
    const { remindersSent, expired } = await withDatabaseContext(database, anonymousPrincipal("job-scheduler"), (context) => runDunningSweep(context));
    if (remindersSent > 0 || expired > 0) console.log(`[jobs] dunning sweep: ${remindersSent} reminder(s) sent, ${expired} subscription(s) expired`);
    return { rescheduleAt: new Date(Date.now() + DUNNING_CHECK_INTERVAL_MS) };
  };
}

/** Registers every built-in job handler and seeds their first run - called once from server.ts, never from app.ts (so it never runs under the test harness). */
export function registerBuiltinJobHandlers(scheduler: JobScheduler, database: Database): void {
  scheduler.register(UPLOAD_EXPIRY_JOB_TYPE, expireStalePendingUploadsHandler(database));
  scheduler.register(DUNNING_CHECK_JOB_TYPE, dunningCheckHandler(database));
}

/** Idempotent: only seeds a recurring job if one isn't already pending/running, so restarts don't pile up duplicates. */
export async function seedBuiltinJobs(database: Database): Promise<void> {
  await withDatabaseContext(database, anonymousPrincipal("job-scheduler-seed"), async (context) => {
    await repository.ensureRecurringJob(context, UPLOAD_EXPIRY_JOB_TYPE, 5);
    await repository.ensureRecurringJob(context, DUNNING_CHECK_JOB_TYPE, 5);
  });
}
