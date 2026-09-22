import { randomUUID } from "node:crypto";
import { Pool } from "pg";

let verificationMessages: { to: string; code: string }[];
let invitationEmails: { to: string; acceptUrl: string }[];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBusinessInvitation: (to: string, params: { acceptUrl: string }) =>
      invitationEmails.push({ to, acceptUrl: params.acceptUrl }),
  },
}));

import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
let migratorPool: Pool;

beforeAll(async () => {
  verificationMessages = [];
  invitationEmails = [];
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});

afterAll(async () => {
  await migratorPool.end();
  await server.close();
});

/** The starter plan (the default for a fresh business) only allows 1 team member - inviting a second requires at least the plus plan. */
async function grantPlusPlan(businessId: string): Promise<void> {
  await migratorPool.query(`insert into app.business_subscriptions ("businessId", "planCode", "status") values ($1, 'plus', 'active')`, [businessId]);
}

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: PASSWORD }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${signup.status} ${JSON.stringify(signup.body)}`);
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  if (!userId) throw new Error(`Sign-up response missing user: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (!code) throw new Error(`Verification code missing for ${email}`);
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies, userId };
}

async function listActions(cookies: string, businessId: string, query = ""): Promise<string[]> {
  const response = await request(server.baseUrl, `/api/businesses/${businessId}/audit-events${query}`, { cookie: cookies });
  expect(response.status).toBe(200);
  return (response.body as { data: { events: { action: string }[] } }).data.events.map((event) => event.action);
}

describe("audit domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/audit-events`)).status).toBe(401);
  });

  it("records team actions performed through the authorization domain", async () => {
    const owner = await authenticate("Audit Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Audit Trail Co" }),
    });
    const businessId = (businessResponse.body as { data: { business: { id: string } } }).data.business.id;
    const base = `/api/businesses/${businessId}`;
    await grantPlusPlan(businessId);

    const roleCreated = await request(server.baseUrl, `${base}/team/roles`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ name: "Cashier", permissionIds: [] }),
    });
    const role = (roleCreated.body as { data: { role: { id: string } } }).data.role;

    const invitee = `audit-invitee-${randomUUID()}@example.com`;
    await request(server.baseUrl, `${base}/team/invitations`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ emails: [invitee], roleId: role.id }),
    });

    let actions = await listActions(owner.cookies, businessId);
    expect(actions).toEqual(expect.arrayContaining(["team.role_created", "team.member_invited"]));

    const sentEmail = invitationEmails.find((message) => message.to === invitee);
    if (!sentEmail) throw new Error("Invitation email was not sent");
    const token = new URL(sentEmail.acceptUrl).searchParams.get("token");
    if (!token) throw new Error("Invitation link missing token");

    const acceptor = await authenticate("Audit Acceptor");
    await request(server.baseUrl, `/api/invitations/${token}/accept`, { method: "POST", cookie: acceptor.cookies });

    actions = await listActions(owner.cookies, businessId);
    expect(actions).toContain("team.member_joined");

    const members = await request(server.baseUrl, `${base}/team/members`, { cookie: owner.cookies });
    const acceptorMembership = (members.body as { data: { members: { id: string; userId: string }[] } }).data.members.find((m) => m.userId === acceptor.userId)!;

    await request(server.baseUrl, `${base}/team/members/${acceptorMembership.id}/roles`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ roleIds: [] }),
    });
    actions = await listActions(owner.cookies, businessId);
    expect(actions).toContain("team.member_role_changed");

    await request(server.baseUrl, `${base}/team/members/${acceptorMembership.id}`, { method: "DELETE", cookie: owner.cookies });
    actions = await listActions(owner.cookies, businessId);
    expect(actions).toContain("team.member_removed");

    await request(server.baseUrl, `${base}/team/roles/${role.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ name: "Cashier Renamed" }),
    });
    actions = await listActions(owner.cookies, businessId);
    expect(actions).toContain("team.role_updated");

    await request(server.baseUrl, `${base}/team/roles/${role.id}`, { method: "DELETE", cookie: owner.cookies });
    actions = await listActions(owner.cookies, businessId);
    expect(actions).toContain("team.role_deleted");

    const filtered = await listActions(owner.cookies, businessId, "?action=team.role_deleted");
    expect(filtered).toEqual(["team.role_deleted"]);
  });

  it("rejects cross-tenant audit log access", async () => {
    const owner = await authenticate("Isolated Audit Owner");
    const outsider = await authenticate("Isolated Audit Outsider");
    const businessResponse = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "Isolated Audit Co" }),
    });
    const businessId = (businessResponse.body as { data: { business: { id: string } } }).data.business.id;

    const forbidden = await request(server.baseUrl, `/api/businesses/${businessId}/audit-events`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
