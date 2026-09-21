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

import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

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
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = (signupBody.user?.id ?? signupBody.data?.user?.id)!;
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId, email, name: label };
}

async function grantPlatformAdmin(userId: string, email: string, name: string, role: string): Promise<void> {
  await migratorPool.query(`insert into app.platform_administrators ("userId", "role", "name", "email") values ($1, $2, $3, $4)`, [userId, role, name, email]);
}

async function raiseSignalDirectly(entityType: string, entityId: string, severity: string): Promise<void> {
  await migratorPool.query(
    `insert into app.risk_signals ("entityType","entityId","signalType","description","severity") values ($1,$2,$3,$4,$5)`,
    [entityType, entityId, "test_signal", "Raised directly for a test", severity],
  );
}

describe("risk domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/risk/signals")).status).toBe(401);
  });

  it("rejects an authenticated user who is not a platform administrator", async () => {
    const outsider = await authenticate("Risk Outsider");
    expect((await request(server.baseUrl, "/api/risk/signals", { cookie: outsider.cookies })).status).toBe(403);
    expect((await request(server.baseUrl, "/api/risk/holds", { cookie: outsider.cookies })).status).toBe(403);
  });

  it("enforces the role hierarchy: viewer can read signals but not review them", async () => {
    const viewer = await authenticate("Risk Viewer");
    await grantPlatformAdmin(viewer.userId, viewer.email, viewer.name, "viewer");
    const entityId = randomUUID();
    await raiseSignalDirectly("business", entityId, "high");

    const listed = await request(server.baseUrl, "/api/risk/signals", { cookie: viewer.cookies });
    expect(listed.status).toBe(200);
    const signal = (listed.body as { data: { data: { id: string; entityId: string }[] } }).data.data.find((s) => s.entityId === entityId)!;
    expect(signal).toBeDefined();

    const reviewBlocked = await request(server.baseUrl, `/api/risk/signals/${signal.id}/review`, {
      method: "PATCH",
      cookie: viewer.cookies,
      body: JSON.stringify({ status: "cleared" }),
    });
    expect(reviewBlocked.status).toBe(403);
  });

  it("lets a support administrator review a signal, group it into a case, and resolve the case", async () => {
    const admin = await authenticate("Risk Support Admin");
    await grantPlatformAdmin(admin.userId, admin.email, admin.name, "support");
    const entityId = randomUUID();
    await raiseSignalDirectly("payment", entityId, "critical");

    const listed = await request(server.baseUrl, "/api/risk/signals?severity=critical", { cookie: admin.cookies });
    const signal = (listed.body as { data: { data: { id: string; entityId: string }[] } }).data.data.find((s) => s.entityId === entityId)!;

    const reviewed = await request(server.baseUrl, `/api/risk/signals/${signal.id}/review`, {
      method: "PATCH",
      cookie: admin.cookies,
      body: JSON.stringify({ status: "investigating", notes: "Looking into this" }),
    });
    expect(reviewed.status).toBe(200);
    expect((reviewed.body as { data: { signal: { status: string; reviewNotes: string } } }).data.signal.status).toBe("investigating");

    const createdCase = await request(server.baseUrl, "/api/risk/cases", {
      method: "POST",
      cookie: admin.cookies,
      body: JSON.stringify({ title: "Suspicious payment pattern", signalIds: [signal.id] }),
    });
    expect(createdCase.status).toBe(201);
    const riskCase = (createdCase.body as { data: { case: { id: string } } }).data.case;

    const caseDetail = await request(server.baseUrl, `/api/risk/cases/${riskCase.id}`, { cookie: admin.cookies });
    expect(caseDetail.status).toBe(200);
    const detail = caseDetail.body as { data: { signals: { id: string }[] } };
    expect(detail.data.signals.map((s) => s.id)).toContain(signal.id);

    const resolved = await request(server.baseUrl, `/api/risk/cases/${riskCase.id}`, {
      method: "PATCH",
      cookie: admin.cookies,
      body: JSON.stringify({ status: "resolved", resolutionNotes: "False positive" }),
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = resolved.body as { data: { case: { status: string; resolvedAt: string | null } } };
    expect(resolvedBody.data.case.status).toBe("resolved");
    expect(resolvedBody.data.case.resolvedAt).not.toBeNull();

    const stats = await request(server.baseUrl, "/api/risk/stats", { cookie: admin.cookies });
    expect(stats.status).toBe(200);
  });

  it("creates and releases a transaction hold, rejecting a second active hold on the same entity", async () => {
    const admin = await authenticate("Risk Hold Admin");
    await grantPlatformAdmin(admin.userId, admin.email, admin.name, "support");
    const businessId = randomUUID();

    const created = await request(server.baseUrl, "/api/risk/holds", {
      method: "POST",
      cookie: admin.cookies,
      body: JSON.stringify({ entityType: "business", entityId: businessId, reason: "Suspicious activity" }),
    });
    expect(created.status).toBe(201);
    const hold = (created.body as { data: { hold: { id: string; status: string } } }).data.hold;
    expect(hold.status).toBe("active");

    const duplicate = await request(server.baseUrl, "/api/risk/holds", {
      method: "POST",
      cookie: admin.cookies,
      body: JSON.stringify({ entityType: "business", entityId: businessId, reason: "Second attempt" }),
    });
    expect(duplicate.status).toBe(409);

    const released = await request(server.baseUrl, `/api/risk/holds/${hold.id}/release`, { method: "POST", cookie: admin.cookies });
    expect(released.status).toBe(200);
    expect((released.body as { data: { hold: { status: string } } }).data.hold.status).toBe("released");

    const doubleRelease = await request(server.baseUrl, `/api/risk/holds/${hold.id}/release`, { method: "POST", cookie: admin.cookies });
    expect(doubleRelease.status).toBe(409);
  });

  it("blocks a withdrawal request when the business has an active hold (banking domain wiring)", async () => {
    const owner = await authenticate("Held Business Owner");
    const businessCreated = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "Held Business" }) });
    const businessId = (businessCreated.body as { data: { business: { id: string } } }).data.business.id;

    const admin = await authenticate("Risk Hold Wiring Admin");
    await grantPlatformAdmin(admin.userId, admin.email, admin.name, "support");
    const holdCreated = await request(server.baseUrl, "/api/risk/holds", {
      method: "POST",
      cookie: admin.cookies,
      body: JSON.stringify({ entityType: "business", entityId: businessId, reason: "Wiring test" }),
    });
    expect(holdCreated.status).toBe(201);

    const withdrawal = await request(server.baseUrl, `/api/businesses/${businessId}/banking/withdrawals`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ amountMinor: 1000, bankCode: "044", accountNumber: "0000000000", accountName: "Test", idempotencyKey: randomUUID() }),
    });
    expect(withdrawal.status).toBe(403);
    expect(JSON.stringify(withdrawal.body)).toMatch(/on hold/i);
  });
});
