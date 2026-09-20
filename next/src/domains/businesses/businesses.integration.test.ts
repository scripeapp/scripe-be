import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];

jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));

import { sql } from "kysely";
import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});

afterAll(async () => server.close());

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

describe("businesses domain", () => {
  it("requires authentication", async () => {
    const response = await request(server.baseUrl, "/api/businesses");
    expect(response.status).toBe(401);
  });

  it("creates the owner membership and default store atomically, then lists and updates the business", async () => {
    const owner = await authenticate("Business Owner");
    const created = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        displayName: "North Star Retail",
        defaultCurrency: "ngn",
        timezone: "Africa/Lagos",
        primaryVertical: "retail",
      }),
    });
    expect(created.status).toBe(201);
    const business = (created.body as { data: { business: { id: string; displayName: string; roleCodes: string[]; defaultStore: { id: string; slug: string } } } }).data.business;
    expect(business.displayName).toBe("North Star Retail");
    expect(business.roleCodes).toContain("owner");
    expect(business.defaultStore.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(business.defaultStore.slug).toMatch(/^north-star-retail-[0-9a-f]{8}$/);

    const counts = await withDatabaseContext(
      getDatabase(),
      withIdentity(randomUUID(), owner.userId, business.id),
      async ({ transaction }) => sql<{ memberships: string; stores: string }>`
        select
          (select count(*)::text from app.business_memberships where "businessId"=${business.id}::uuid and "status"='active') as memberships,
          (select count(*)::text from app.stores where "businessId"=${business.id}::uuid and "isDefault" and "status" <> 'archived') as stores
      `.execute(transaction),
    );
    expect(counts.rows[0]).toEqual({ memberships: "1", stores: "1" });

    const listed = await request(server.baseUrl, "/api/businesses", { cookie: owner.cookies });
    expect(listed.status).toBe(200);
    expect((listed.body as { data: { businesses: { id: string }[] } }).data.businesses.map((item) => item.id)).toContain(business.id);

    const updated = await request(server.baseUrl, `/api/businesses/${business.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "North Star Commerce", defaultCurrency: "USD" }),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { business: { displayName: string; defaultCurrency: string } } }).data.business).toMatchObject({ displayName: "North Star Commerce", defaultCurrency: "USD" });

    const outsider = await authenticate("Outsider");
    const forbidden = await request(server.baseUrl, `/api/businesses/${business.id}`, {
      method: "PATCH",
      cookie: outsider.cookies,
      body: JSON.stringify({ displayName: "Hijacked" }),
    });
    expect(forbidden.status).toBe(403);

    const invisible = await request(server.baseUrl, `/api/businesses/${business.id}`, { cookie: outsider.cookies });
    expect(invisible.status).toBe(404);
  });

  it("rejects invalid business contracts before database work", async () => {
    const owner = await authenticate("Validation Owner");
    const response = await request(server.baseUrl, "/api/businesses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ displayName: "", defaultCurrency: "NAIRA" }),
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
  });
});
