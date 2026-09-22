import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBusinessInvitation: () => {},
    sendTransactional: () => Promise.resolve(),
  },
}));

import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { anonymousPrincipal } from "@/db/principal.js";
import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import { registerBuiltinJobHandlers, seedBuiltinJobs } from "./jobs.handlers.js";
import { JobScheduler, scheduleJob } from "./jobs.service.js";

let server: TestServer;
let migratorPool: Pool;

beforeAll(async () => {
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});
afterAll(async () => {
  await migratorPool.end();
  await server.close();
});

async function authenticate(label: string): Promise<{ cookies: string; userId: string; email: string; name: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = (body.user?.id ?? body.data?.user?.id)!;
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId, email, name: label };
}

async function grantPlatformAdmin(userId: string, email: string, name: string, role: string): Promise<void> {
  await migratorPool.query(`insert into app.platform_administrators ("userId", "role", "name", "email") values ($1, $2, $3, $4)`, [userId, role, name, email]);
}

describe("jobs domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/jobs")).status).toBe(401);
  });

  it("rejects an authenticated user who is not a platform administrator", async () => {
    const outsider = await authenticate("Jobs Outsider");
    expect((await request(server.baseUrl, "/api/jobs", { cookie: outsider.cookies })).status).toBe(403);
  });

  it("lists jobs, gets a job with its attempt history, and lets a support administrator rerun or cancel", async () => {
    const admin = await authenticate("Jobs Admin");
    await grantPlatformAdmin(admin.userId, admin.email, admin.name, "support");

    const type = `test.observable.${randomUUID()}`;
    await migratorPool.query(`insert into app.jobs ("type") values ($1)`, [type]);

    const listed = await request(server.baseUrl, `/api/jobs?type=${type}`, { cookie: admin.cookies });
    expect(listed.status).toBe(200);
    const job = (listed.body as { data: { data: { id: string; status: string }[] } }).data.data[0]!;
    expect(job.status).toBe("pending");

    const cancelled = await request(server.baseUrl, `/api/jobs/${job.id}/cancel`, { method: "POST", cookie: admin.cookies });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body as { data: { job: { status: string } } }).data.job.status).toBe("cancelled");

    const rerunBlocked = await request(server.baseUrl, `/api/jobs/${job.id}/rerun`, { method: "POST", cookie: admin.cookies });
    // rerun is only meaningful semantically for a non-running job; a cancelled job can still be manually requeued to pending.
    expect(rerunBlocked.status).toBe(200);
    expect((rerunBlocked.body as { data: { job: { status: string } } }).data.job.status).toBe("pending");

    const detail = await request(server.baseUrl, `/api/jobs/${job.id}`, { cookie: admin.cookies });
    expect(detail.status).toBe(200);
    expect((detail.body as { data: { job: { id: string } } }).data.job.id).toBe(job.id);
  });

  it("claims, runs, and completes a job through the real scheduler and security-definer functions", async () => {
    const database = getDatabase();
    const scheduler = new JobScheduler(database, { batchSize: 5, leaseSeconds: 30, worker: "test-worker" });

    let handlerCalls = 0;
    const jobType = `test.scheduler.${randomUUID()}`;
    scheduler.register(jobType, () => {
      handlerCalls += 1;
      return Promise.resolve();
    });

    await withDatabaseContext(database, anonymousPrincipal("test"), (context) => scheduleJob(context, { type: jobType }));
    await scheduler.tick();

    expect(handlerCalls).toBe(1);
    const status = await migratorPool.query<{ status: string; attempts: number }>(`select status, attempts from app.jobs where type = $1`, [jobType]);
    expect(status.rows[0]).toEqual({ status: "succeeded", attempts: 1 });
  });

  it("retries a failing job with backoff, then gives up after maxAttempts", async () => {
    const database = getDatabase();
    const scheduler = new JobScheduler(database, { batchSize: 5, leaseSeconds: 30, worker: "test-worker" });

    const jobType = `test.failing.${randomUUID()}`;
    scheduler.register(jobType, () => Promise.reject(new Error("simulated failure")));

    await withDatabaseContext(database, anonymousPrincipal("test"), (context) => scheduleJob(context, { type: jobType, maxAttempts: 2 }));

    await scheduler.tick();
    const afterFirst = await migratorPool.query<{ status: string; attempts: number; lastError: string }>(`select status, attempts, "lastError" from app.jobs where type = $1`, [jobType]);
    expect(afterFirst.rows[0]).toEqual({ status: "pending", attempts: 1, lastError: "simulated failure" });

    await migratorPool.query(`update app.jobs set "runAt" = now() where type = $1`, [jobType]);
    await scheduler.tick();
    const afterSecond = await migratorPool.query<{ status: string; attempts: number }>(`select status, attempts from app.jobs where type = $1`, [jobType]);
    expect(afterSecond.rows[0]).toEqual({ status: "failed", attempts: 2 });
  });

  it("self-reschedules a recurring job when the handler returns rescheduleAt", async () => {
    const database = getDatabase();
    const scheduler = new JobScheduler(database, { batchSize: 5, leaseSeconds: 30, worker: "test-worker" });

    const jobType = `test.recurring.${randomUUID()}`;
    const rescheduleAt = new Date(Date.now() + 60_000);
    scheduler.register(jobType, () => Promise.resolve({ rescheduleAt }));

    await withDatabaseContext(database, anonymousPrincipal("test"), (context) => scheduleJob(context, { type: jobType }));
    await scheduler.tick();

    const row = await migratorPool.query<{ status: string; attempts: number; runAt: Date }>(`select status, attempts, "runAt" from app.jobs where type = $1`, [jobType]);
    expect(row.rows[0]!.status).toBe("pending");
    expect(row.rows[0]!.attempts).toBe(0);
    expect(row.rows[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("wires the built-in upload-expiry job end to end: seeding is idempotent, and running it expires a stale pending upload", async () => {
    const database = getDatabase();
    const scheduler = new JobScheduler(database, { batchSize: 5, leaseSeconds: 30, worker: "test-worker" });
    registerBuiltinJobHandlers(scheduler, database);

    await seedBuiltinJobs(database);
    await seedBuiltinJobs(database); // idempotent - must not create a second pending row
    const seeded = await migratorPool.query<{ count: string }>(
      `select count(*)::text as count from app.jobs where type = 'uploads.expire_stale_pending' and status in ('pending','running')`,
    );
    expect(seeded.rows[0]!.count).toBe("1");

    const user = await migratorPool.query<{ id: string }>(`select id from auth."user" limit 1`);
    let userId = user.rows[0]?.id;
    if (!userId) {
      const created = await migratorPool.query<{ id: string }>(
        `insert into auth."user" ("id","name","email","emailVerified") values (gen_random_uuid(), 'Stale Upload Owner', $1, true) returning id`,
        [`stale-owner-${randomUUID()}@example.com`],
      );
      userId = created.rows[0]!.id;
    }

    const staleUpload = await migratorPool.query<{ id: string }>(
      `insert into app.uploads ("userId","purpose","objectKey","mimeType","sizeBytes","status","createdAt")
       values ($1,'avatar',$2,'image/png',100,'pending', now() - interval '48 hours') returning id`,
      [userId, `stale-${randomUUID()}`],
    );

    await migratorPool.query(`update app.jobs set "runAt" = now() where type = 'uploads.expire_stale_pending'`);
    await scheduler.tick();

    const upload = await migratorPool.query<{ status: string }>(`select status from app.uploads where id = $1`, [staleUpload.rows[0]!.id]);
    expect(upload.rows[0]!.status).toBe("failed");

    const jobAfter = await migratorPool.query<{ status: string; runAt: Date }>(`select status, "runAt" from app.jobs where type = 'uploads.expire_stale_pending'`);
    expect(jobAfter.rows[0]!.status).toBe("pending");
    expect(jobAfter.rows[0]!.runAt.getTime()).toBeGreaterThan(Date.now());
  });
});
