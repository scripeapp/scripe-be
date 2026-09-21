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

/** The starter plan (the default for a fresh business) only allows 1 team member - inviting a second requires at least the plus plan, so tests exercising invites grant one directly rather than going through real Paystack checkout. */
async function grantPlusPlan(businessId: string): Promise<void> {
  await migratorPool.query(`insert into app.business_subscriptions ("businessId", "planCode", "status") values ($1, 'plus', 'active')`, [businessId]);
}

async function authenticate(label: string): Promise<{ cookies: string; userId: string; email: string }> {
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
  return { cookies: verified.cookies, userId, email };
}

async function createBusiness(cookies: string, displayName: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName }),
  });
  if (created.status !== 201) throw new Error(`Business creation failed: ${JSON.stringify(created.body)}`);
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

describe("authorization domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/permissions")).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/team/members`)).status).toBe(401);
  });

  it("lists the global permission catalog", async () => {
    const owner = await authenticate("Permission Reader");
    const response = await request(server.baseUrl, "/api/permissions", { cookie: owner.cookies });
    expect(response.status).toBe(200);
    const permissions = (response.body as { data: { permissions: { code: string }[] } }).data.permissions;
    expect(permissions.map((p) => p.code)).toEqual(expect.arrayContaining(["business.read", "team.manage"]));
  });

  it("seeds the owner as the sole member with every permission", async () => {
    const owner = await authenticate("Team Owner");
    const businessId = await createBusiness(owner.cookies, "Owner Seed Co");

    const members = await request(server.baseUrl, `/api/businesses/${businessId}/team/members`, { cookie: owner.cookies });
    expect(members.status).toBe(200);
    const memberList = (members.body as { data: { members: { userId: string; roles: { code: string }[]; permissionCodes: string[] }[] } }).data.members;
    expect(memberList).toHaveLength(1);
    expect(memberList[0]!.roles.map((role) => role.code)).toEqual(["owner"]);
    expect(memberList[0]!.permissionCodes).toEqual(expect.arrayContaining(["team.manage", "team.invite", "business.update"]));

    const me = await request(server.baseUrl, `/api/businesses/${businessId}/team/me`, { cookie: owner.cookies });
    expect(me.status).toBe(200);
    expect((me.body as { data: { membership: { userId: string } } }).data.membership.userId).toBe(owner.userId);
  });

  it("blocks changing or removing the owner", async () => {
    const owner = await authenticate("Protected Owner");
    const businessId = await createBusiness(owner.cookies, "Protected Co");
    const members = (await request(server.baseUrl, `/api/businesses/${businessId}/team/members`, { cookie: owner.cookies }))
      .body as { data: { members: { id: string }[] } };
    const ownerMembershipId = members.data.members[0]!.id;

    const reroled = await request(server.baseUrl, `/api/businesses/${businessId}/team/members/${ownerMembershipId}/roles`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ roleIds: [] }),
    });
    expect(reroled.status).toBe(403);

    const removed = await request(server.baseUrl, `/api/businesses/${businessId}/team/members/${ownerMembershipId}`, {
      method: "DELETE",
      cookie: owner.cookies,
    });
    expect(removed.status).toBe(403);
  });

  it("creates a custom role, invites by email, and accepts into that role", async () => {
    const owner = await authenticate("Inviting Owner");
    const businessId = await createBusiness(owner.cookies, "Invite Flow Co");
    await grantPlusPlan(businessId);

    const roleCreated = await request(server.baseUrl, `/api/businesses/${businessId}/team/roles`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ name: "Cashier", permissionIds: [] }),
    });
    expect(roleCreated.status).toBe(201);
    const role = (roleCreated.body as { data: { role: { id: string; code: string } } }).data.role;
    expect(role.code).toBe("cashier");

    const invitee = `cashier-${randomUUID()}@example.com`;
    const invited = await request(server.baseUrl, `/api/businesses/${businessId}/team/invitations`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ emails: [invitee], roleId: role.id }),
    });
    expect(invited.status).toBe(201);
    const results = (invited.body as { data: { results: { email: string; success: boolean; invitationId?: string }[] } }).data.results;
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ email: invitee, success: true });

    const pending = await request(server.baseUrl, `/api/businesses/${businessId}/team/invitations`, { cookie: owner.cookies });
    expect((pending.body as { data: { invitations: unknown[] } }).data.invitations).toHaveLength(1);

    const sentEmail = invitationEmails.find((message) => message.to === invitee);
    if (!sentEmail) throw new Error("Invitation email was not sent");
    const token = new URL(sentEmail.acceptUrl).searchParams.get("token");
    if (!token) throw new Error("Invitation link missing token");

    const acceptor = await authenticate("Cashier Acceptor");
    const accepted = await request(server.baseUrl, `/api/invitations/${token}/accept`, {
      method: "POST",
      cookie: acceptor.cookies,
    });
    expect(accepted.status).toBe(201);
    expect((accepted.body as { data: { accepted: { businessId: string } } }).data.accepted.businessId).toBe(businessId);

    const members = await request(server.baseUrl, `/api/businesses/${businessId}/team/members`, { cookie: owner.cookies });
    const memberList = (members.body as { data: { members: { userId: string; roles: { code: string }[] }[] } }).data.members;
    expect(memberList).toHaveLength(2);
    expect(memberList.find((m) => m.userId === acceptor.userId)?.roles.map((r) => r.code)).toEqual(["cashier"]);

    const reusedToken = await request(server.baseUrl, `/api/invitations/${token}/accept`, {
      method: "POST",
      cookie: owner.cookies,
    });
    expect(reusedToken.status).toBe(404);
  });

  it("rejects assigning the owner role and inviting into it", async () => {
    const owner = await authenticate("Guard Owner");
    const businessId = await createBusiness(owner.cookies, "Guard Co");
    const ownerRole = await request(server.baseUrl, `/api/businesses/${businessId}/team/roles`, { cookie: owner.cookies });
    const ownerRoleId = (ownerRole.body as { data: { roles: { code: string; id: string }[] } }).data.roles.find((r) => r.code === "owner")!.id;

    const invited = await request(server.baseUrl, `/api/businesses/${businessId}/team/invitations`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ emails: [`nope-${randomUUID()}@example.com`], roleId: ownerRoleId }),
    });
    expect(invited.status).toBe(400);
  });

  it("rejects an invalid or expired invitation token", async () => {
    const user = await authenticate("Token Skeptic");
    const response = await request(server.baseUrl, `/api/invitations/${randomUUID()}/accept`, {
      method: "POST",
      cookie: user.cookies,
    });
    expect(response.status).toBe(404);
  });
});
