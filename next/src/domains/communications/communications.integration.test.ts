import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
const sentEmails: { to: string; subject: string; from?: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBusinessInvitation: () => {},
    sendTransactional: (params: { to: string; subject: string; from?: string }) => {
      sentEmails.push(params);
      return Promise.resolve();
    },
  },
}));
jest.mock("node:dns/promises", () => ({ resolveTxt: jest.fn() }));

import { resolveTxt } from "node:dns/promises";
import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);

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

async function actor(label: string): Promise<{ userId: string; cookies: string; email: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { userId: (body.user?.id ?? body.data?.user?.id)!, cookies: verified.cookies, email };
}

async function createBusinessWithBase(owner: { cookies: string }, name: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: name }) });
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

async function createCustomerWithContact(
  owner: { cookies: string },
  base: string,
  name: string,
  contact: { kind: "email" | "phone"; value: string },
): Promise<string> {
  const created = await request(server.baseUrl, `${base}/customers`, {
    method: "POST",
    cookie: owner.cookies,
    body: JSON.stringify({ kind: "person", displayName: name, customer: {} }),
  });
  const partyId = (created.body as { data: { customer: { id: string } } }).data.customer.id;
  await request(server.baseUrl, `${base}/parties/${partyId}/contacts`, {
    method: "POST",
    cookie: owner.cookies,
    body: JSON.stringify({ kind: contact.kind, value: contact.value, isPrimary: true }),
  });
  return partyId;
}

async function grantCreditsDirectly(businessId: string, credits: number): Promise<void> {
  await migratorPool.query(
    `insert into app.communication_credit_accounts ("businessId","balance") values ($1,$2)
     on conflict ("businessId") do update set "balance" = app.communication_credit_accounts."balance" + excluded."balance"`,
    [businessId, credits],
  );
}

describe("communications domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/communications/messages`)).status).toBe(401);
  });

  it("rejects a non-member of the business", async () => {
    const owner = await actor("Comms Owner Guard");
    const outsider = await actor("Comms Outsider");
    const businessId = await createBusinessWithBase(owner, "Guarded Co");
    const response = await request(server.baseUrl, `/api/businesses/${businessId}/communications/messages`, { cookie: outsider.cookies });
    expect(response.status).toBe(403);
  });

  it("manages sending domains and senders, and the first sender becomes the default automatically", async () => {
    const owner = await actor("Sender Owner");
    const businessId = await createBusinessWithBase(owner, "Sender Test Co");
    const base = `/api/businesses/${businessId}`;

    (resolveTxt as jest.Mock).mockResolvedValueOnce([]);
    const domainCreated = await request(server.baseUrl, `${base}/communications/domains`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ domain: "example.com" }) });
    expect(domainCreated.status).toBe(201);
    const domain = (domainCreated.body as { data: { domain: { id: string; dnsRecords: { value: string }[] } } }).data.domain;

    const failedVerify = await request(server.baseUrl, `${base}/communications/domains/${domain.id}/verify`, { method: "POST", cookie: owner.cookies });
    expect(failedVerify.status).toBe(400);

    (resolveTxt as jest.Mock).mockResolvedValueOnce([[domain.dnsRecords[0]!.value]]);
    const verified = await request(server.baseUrl, `${base}/communications/domains/${domain.id}/verify`, { method: "POST", cookie: owner.cookies });
    expect(verified.status).toBe(200);
    expect((verified.body as { data: { domain: { status: string } } }).data.domain.status).toBe("verified");

    const senderRejected = await request(server.baseUrl, `${base}/communications/senders`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ name: "Sales", email: "sales@notexample.com", domainId: domain.id }),
    });
    expect(senderRejected.status).toBe(400);

    const sender = await request(server.baseUrl, `${base}/communications/senders`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ name: "Sales", email: "sales@example.com", domainId: domain.id }),
    });
    expect(sender.status).toBe(201);
    expect((sender.body as { data: { sender: { isDefault: boolean } } }).data.sender.isDefault).toBe(true);

    const deleteBlocked = await request(server.baseUrl, `${base}/communications/domains/${domain.id}`, { method: "DELETE", cookie: owner.cookies });
    expect(deleteBlocked.status).toBe(400);
  });

  it("manages templates and audience segments", async () => {
    const owner = await actor("Segment Owner");
    const businessId = await createBusinessWithBase(owner, "Segment Test Co");
    const base = `/api/businesses/${businessId}`;

    const template = await request(server.baseUrl, `${base}/communications/templates`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "sms", name: "Promo", body: "Hello {{name}}, 20% off today!" }),
    });
    expect(template.status).toBe(201);

    const invalidTemplate = await request(server.baseUrl, `${base}/communications/templates`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "email", name: "No subject", body: "Missing subject" }),
    });
    expect(invalidTemplate.status).toBe(400);

    const partyId = await createCustomerWithContact(owner, base, "VIP Customer", { kind: "phone", value: "+2348011111111" });

    const segment = await request(server.baseUrl, `${base}/communications/segments`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ name: "VIPs" }) });
    expect(segment.status).toBe(201);
    const segmentId = (segment.body as { data: { segment: { id: string } } }).data.segment.id;

    const addMember = await request(server.baseUrl, `${base}/communications/segments/${segmentId}/members`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ partyIds: [partyId] }),
    });
    expect(addMember.status).toBe(201);

    const members = await request(server.baseUrl, `${base}/communications/segments/${segmentId}/members`, { cookie: owner.cookies });
    expect((members.body as { data: { members: { partyId: string }[] } }).data.members.map((m) => m.partyId)).toContain(partyId);

    const removed = await request(server.baseUrl, `${base}/communications/segments/${segmentId}/members/${partyId}`, { method: "DELETE", cookie: owner.cookies });
    expect(removed.status).toBe(200);
  });

  it("excludes an opted-out party from cost estimates and sends", async () => {
    const owner = await actor("OptOut Owner");
    const businessId = await createBusinessWithBase(owner, "OptOut Test Co");
    const base = `/api/businesses/${businessId}`;
    const partyId = await createCustomerWithContact(owner, base, "Opted Out Customer", { kind: "phone", value: "+2348022222222" });

    const beforeOptOut = await request(server.baseUrl, `${base}/communications/messages/estimate`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "sms", audienceType: "all", body: "Hello there" }),
    });
    expect((beforeOptOut.body as { data: { estimate: { recipientCount: number } } }).data.estimate.recipientCount).toBe(1);

    const optOut = await request(server.baseUrl, `${base}/communications/opt-outs`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ partyId, channel: "sms", reason: "requested" }),
    });
    expect(optOut.status).toBe(201);

    const afterOptOut = await request(server.baseUrl, `${base}/communications/messages/estimate`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "sms", audienceType: "all", body: "Hello there" }),
    });
    expect((afterOptOut.body as { data: { estimate: { recipientCount: number } } }).data.estimate.recipientCount).toBe(0);
  });

  it("blocks sending without enough credits, then sends successfully after a top-up, debiting credits and recording deliveries", async () => {
    const owner = await actor("Sender Flow Owner");
    const businessId = await createBusinessWithBase(owner, "Sender Flow Co");
    const base = `/api/businesses/${businessId}`;
    await createCustomerWithContact(owner, base, "SMS Recipient", { kind: "phone", value: "+2348033333333" });

    const draft = await request(server.baseUrl, `${base}/communications/messages`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "sms", name: "Launch blast", audienceType: "all", body: "We just launched!" }),
    });
    expect(draft.status).toBe(201);
    const messageId = (draft.body as { data: { message: { id: string } } }).data.message.id;

    const blocked = await request(server.baseUrl, `${base}/communications/messages/${messageId}/send`, { method: "POST", cookie: owner.cookies });
    expect(blocked.status).toBe(400);

    const afterFailedSend = await request(server.baseUrl, `${base}/communications/messages/${messageId}`, { cookie: owner.cookies });
    expect((afterFailedSend.body as { data: { message: { status: string } } }).data.message.status).toBe("draft");

    await grantCreditsDirectly(businessId, 1000);

    const sent = await request(server.baseUrl, `${base}/communications/messages/${messageId}/send`, { method: "POST", cookie: owner.cookies });
    expect(sent.status).toBe(200);
    const sentBody = sent.body as { data: { message: { status: string; sentCount: number; creditsSpent: string }; deliveries: { status: string }[] } };
    expect(sentBody.data.message.status).toBe("sent");
    expect(sentBody.data.message.sentCount).toBe(1);
    expect(sentBody.data.deliveries).toHaveLength(1);
    expect(sentBody.data.deliveries[0]!.status).toBe("sent");
    expect(Number(sentBody.data.message.creditsSpent)).toBeGreaterThan(0);

    const account = await request(server.baseUrl, `${base}/communications/credits/account`, { cookie: owner.cookies });
    const accountBody = account.body as { data: { account: { balance: string } } };
    expect(Number(accountBody.data.account.balance)).toBe(1000 - Number(sentBody.data.message.creditsSpent));

    const resend = await request(server.baseUrl, `${base}/communications/messages/${messageId}/send`, { method: "POST", cookie: owner.cookies });
    expect(resend.status).toBe(409);
  });

  it("sends an email message through the resolved default sender", async () => {
    const owner = await actor("Email Send Owner");
    const businessId = await createBusinessWithBase(owner, "Email Send Co");
    const base = `/api/businesses/${businessId}`;
    await createCustomerWithContact(owner, base, "Email Recipient", { kind: "email", value: "recipient@example.com" });
    await grantCreditsDirectly(businessId, 1000);

    const draft = await request(server.baseUrl, `${base}/communications/messages`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ channel: "email", name: "Newsletter", audienceType: "all", subject: "Hello!", body: "<p>Hi there</p>" }),
    });
    const messageId = (draft.body as { data: { message: { id: string } } }).data.message.id;

    const sent = await request(server.baseUrl, `${base}/communications/messages/${messageId}/send`, { method: "POST", cookie: owner.cookies });
    expect(sent.status).toBe(200);
    expect(sentEmails.some((email) => email.to === "recipient@example.com" && email.subject === "Hello!")).toBe(true);
  });

  it("initiates a credit top-up checkout and credits the account once the webhook-equivalent completion runs", async () => {
    const owner = await actor("Topup Owner");
    const businessId = await createBusinessWithBase(owner, "Topup Co");
    const base = `/api/businesses/${businessId}`;

    const previousPaystackKey = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "sk_test_paystack";
    // Echoes back whatever reference the service generated, like the real gateway does — a fixed literal would collide with a row a previous test run already inserted, since the service's own randomUUID()-based reference is the only thing making each call's row unique.
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementationOnce((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { reference: string };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: true, message: "ok", data: { authorization_url: "https://paystack.test/pay", access_code: "abc", reference: body.reference } }),
      } as Response);
    });

    const initiated = await request(server.baseUrl, `${base}/communications/credits/topups`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ packageId: "credits_1000", gateway: "paystack" }),
    });
    fetchSpy.mockRestore();
    process.env.PAYSTACK_SECRET_KEY = previousPaystackKey;
    expect(initiated.status).toBe(201);
    const topup = initiated.body as { data: { authorizationUrl: string; reference: string } };
    expect(topup.data.authorizationUrl).toBe("https://paystack.test/pay");

    const completed = await migratorPool.query<{ found: boolean; alreadyCompleted: boolean; credits: string }>(
      "select * from app.complete_communication_credit_topup($1)",
      [topup.data.reference],
    );
    expect(completed.rows[0]!.found).toBe(true);
    expect(completed.rows[0]!.alreadyCompleted).toBe(false);

    const account = await request(server.baseUrl, `${base}/communications/credits/account`, { cookie: owner.cookies });
    expect((account.body as { data: { account: { balance: string } } }).data.account.balance).toBe("1000");
  });
});
