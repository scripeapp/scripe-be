import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
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
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  if (!userId) throw new Error(`Sign-up response missing user: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies, userId, email, name: label };
}

/**
 * Grants platform-administrator status directly against the database,
 * connected as the migrator role (schema owner, exempt from RLS) - the same
 * bypass db/bootstrap-platform-admin.ts uses for the real first grant, since
 * no API path can create the first administrator.
 */
async function grantPlatformAdmin(userId: string, email: string, name: string, role: string): Promise<string> {
  const result = await migratorPool.query<{ id: string }>(
    `insert into app.platform_administrators ("userId", "role", "name", "email") values ($1, $2, $3, $4) returning "id"`,
    [userId, role, name, email],
  );
  return result.rows[0]!.id;
}

describe("platform domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/platform/administrators")).status).toBe(401);
    expect((await request(server.baseUrl, "/api/platform/alerts")).status).toBe(401);
    expect((await request(server.baseUrl, "/api/platform/announcements")).status).toBe(401);
  });

  it("rejects an authenticated user who is not a platform administrator", async () => {
    const outsider = await authenticate("Regular User");
    expect((await request(server.baseUrl, "/api/platform/administrators", { cookie: outsider.cookies })).status).toBe(403);
    expect((await request(server.baseUrl, "/api/platform/alerts", { cookie: outsider.cookies })).status).toBe(403);
    expect((await request(server.baseUrl, "/api/platform/announcements", { cookie: outsider.cookies })).status).toBe(403);
  });

  it("enforces the role hierarchy: viewer can read alerts but not manage announcements or admins", async () => {
    const viewerUser = await authenticate("Viewer Admin");
    await grantPlatformAdmin(viewerUser.userId, viewerUser.email, viewerUser.name, "viewer");

    const alerts = await request(server.baseUrl, "/api/platform/alerts", { cookie: viewerUser.cookies });
    expect(alerts.status).toBe(200);

    const createAnnouncement = await request(server.baseUrl, "/api/platform/announcements", {
      method: "POST",
      cookie: viewerUser.cookies,
      body: JSON.stringify({ title: "Nope", body: "Should be forbidden", type: "info", audience: "all" }),
    });
    expect(createAnnouncement.status).toBe(403);

    const listAdmins = await request(server.baseUrl, "/api/platform/administrators", { cookie: viewerUser.cookies });
    expect(listAdmins.status).toBe(403);
  });

  it("lets a support administrator run the full announcement lifecycle", async () => {
    const supportUser = await authenticate("Support Admin");
    await grantPlatformAdmin(supportUser.userId, supportUser.email, supportUser.name, "support");

    const created = await request(server.baseUrl, "/api/platform/announcements", {
      method: "POST",
      cookie: supportUser.cookies,
      body: JSON.stringify({
        title: "Scheduled maintenance",
        body: "We will be down briefly.",
        type: "maintenance",
        audience: "all",
        ctaLabel: "Status page",
        ctaUrl: "https://status.example.com",
      }),
    });
    expect(created.status).toBe(201);
    const announcement = (created.body as { data: { announcement: { id: string; ctaLabel: string; endsAt: string | null } } }).data.announcement;
    expect(announcement.ctaLabel).toBe("Status page");

    const listed = await request(server.baseUrl, "/api/platform/announcements", { cookie: supportUser.cookies });
    expect(listed.status).toBe(200);
    const listedBody = listed.body as { data: { data: { id: string }[]; total: number } };
    expect(listedBody.data.data.map((entry) => entry.id)).toContain(announcement.id);

    const updated = await request(server.baseUrl, `/api/platform/announcements/${announcement.id}`, {
      method: "PATCH",
      cookie: supportUser.cookies,
      body: JSON.stringify({ isActive: false }),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { announcement: { isActive: boolean } } }).data.announcement.isActive).toBe(false);

    const deleted = await request(server.baseUrl, `/api/platform/announcements/${announcement.id}`, {
      method: "DELETE",
      cookie: supportUser.cookies,
    });
    expect(deleted.status).toBe(200);

    const afterDelete = await request(server.baseUrl, `/api/platform/announcements/${announcement.id}`, {
      method: "PATCH",
      cookie: supportUser.cookies,
      body: JSON.stringify({ isActive: true }),
    });
    expect(afterDelete.status).toBe(404);
  });

  it("rejects a CTA label without a CTA url", async () => {
    const supportUser = await authenticate("Support Admin CTA");
    await grantPlatformAdmin(supportUser.userId, supportUser.email, supportUser.name, "support");

    const response = await request(server.baseUrl, "/api/platform/announcements", {
      method: "POST",
      cookie: supportUser.cookies,
      body: JSON.stringify({ title: "Broken", body: "Missing URL", type: "info", audience: "all", ctaLabel: "Click me" }),
    });
    expect(response.status).toBe(400);
  });

  it("lets a super_admin manage other administrators, but not deactivate themselves", async () => {
    const superAdmin = await authenticate("Super Admin");
    await grantPlatformAdmin(superAdmin.userId, superAdmin.email, superAdmin.name, "super_admin");

    const newHire = await authenticate("New Hire");
    const created = await request(server.baseUrl, "/api/platform/administrators", {
      method: "POST",
      cookie: superAdmin.cookies,
      body: JSON.stringify({ email: newHire.email, name: "New Hire", role: "support" }),
    });
    expect(created.status).toBe(201);
    const newAdmin = (created.body as { data: { administrator: { id: string; role: string } } }).data.administrator;
    expect(newAdmin.role).toBe("support");

    const duplicate = await request(server.baseUrl, "/api/platform/administrators", {
      method: "POST",
      cookie: superAdmin.cookies,
      body: JSON.stringify({ email: newHire.email, name: "New Hire", role: "viewer" }),
    });
    expect(duplicate.status).toBe(409);

    const unknownEmail = await request(server.baseUrl, "/api/platform/administrators", {
      method: "POST",
      cookie: superAdmin.cookies,
      body: JSON.stringify({ email: `nobody-${randomUUID()}@example.com`, name: "Ghost", role: "viewer" }),
    });
    expect(unknownEmail.status).toBe(400);

    const promoted = await request(server.baseUrl, `/api/platform/administrators/${newAdmin.id}`, {
      method: "PATCH",
      cookie: superAdmin.cookies,
      body: JSON.stringify({ role: "finance" }),
    });
    expect(promoted.status).toBe(200);
    expect((promoted.body as { data: { administrator: { role: string } } }).data.administrator.role).toBe("finance");

    const listed = await request(server.baseUrl, "/api/platform/administrators", { cookie: superAdmin.cookies });
    const administrators = (listed.body as { data: { administrators: { id: string; email: string }[] } }).data.administrators;
    expect(administrators.map((entry) => entry.id)).toContain(newAdmin.id);
    const selfId = administrators.find((entry) => entry.email === superAdmin.email)!.id;

    const selfDeactivate = await request(server.baseUrl, `/api/platform/administrators/${selfId}`, {
      method: "DELETE",
      cookie: superAdmin.cookies,
    });
    expect(selfDeactivate.status).toBe(400);

    const deactivated = await request(server.baseUrl, `/api/platform/administrators/${newAdmin.id}`, {
      method: "DELETE",
      cookie: superAdmin.cookies,
    });
    expect(deactivated.status).toBe(200);
  });

  it("supports the alert read/unread/mark-read flow using the internal (non-route) creation path", async () => {
    const viewerUser = await authenticate("Alert Viewer");
    await grantPlatformAdmin(viewerUser.userId, viewerUser.email, viewerUser.name, "viewer");

    const alertId = (
      await migratorPool.query<{ id: string }>(
        `insert into app.admin_alerts ("type", "severity", "title", "message") values ($1, $2, $3, $4) returning "id"`,
        ["large_transaction", "critical", "Large transaction", "A business processed a large payment."],
      )
    ).rows[0]!.id;

    const unreadBefore = await request(server.baseUrl, "/api/platform/alerts/unread-count", { cookie: viewerUser.cookies });
    expect((unreadBefore.body as { data: { count: number } }).data.count).toBeGreaterThanOrEqual(1);

    const listed = await request(server.baseUrl, "/api/platform/alerts", { cookie: viewerUser.cookies });
    const listedBody = listed.body as { data: { data: { id: string; isRead: boolean }[] } };
    expect(listedBody.data.data.map((alert) => alert.id)).toContain(alertId);

    const markedRead = await request(server.baseUrl, "/api/platform/alerts/read", {
      method: "PATCH",
      cookie: viewerUser.cookies,
      body: JSON.stringify({ alertIds: [alertId] }),
    });
    expect(markedRead.status).toBe(200);

    const afterRead = await request(server.baseUrl, "/api/platform/alerts?unreadOnly=true", { cookie: viewerUser.cookies });
    expect((afterRead.body as { data: { data: { id: string }[] } }).data.data.map((alert) => alert.id)).not.toContain(alertId);
  });
});
