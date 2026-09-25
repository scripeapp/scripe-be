import { createHmac, randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
const sentEmails: { to: string; subject: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBusinessInvitation: () => {},
    sendTransactional: (params: { to: string; subject: string }) => {
      sentEmails.push(params);
      return Promise.resolve();
    },
  },
}));

import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { anonymousPrincipal } from "@/db/principal.js";
import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
import { runDunningSweep } from "./subscriptions.service.js";

const PAYSTACK_SECRET = "test-paystack-secret";
let server: TestServer;
let migratorPool: Pool;

let previousPaystackSecretKey: string | undefined;

beforeAll(async () => {
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
  // Signs incoming webhooks (verifyPaystackSignature) - separate from the
  // per-test PAYSTACK_SECRET_KEY overrides used for the outgoing-checkout
  // fetch mocks below, which don't need to match this value.
  previousPaystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
  process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET;
});
afterAll(async () => {
  process.env.PAYSTACK_SECRET_KEY = previousPaystackSecretKey;
  await migratorPool.end();
  await server.close();
});

async function authenticate(label: string): Promise<{ cookies: string; userId: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const userId = (body.user?.id ?? body.data?.user?.id)!;
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies, userId };
}

async function createBusiness(owner: { cookies: string }, name: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: name }) });
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

function paystackSignature(rawBody: string): string {
  return createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
}

async function postPaystackWebhook(payload: unknown): Promise<{ status: number }> {
  const rawBody = JSON.stringify(payload);
  const response = await request(server.baseUrl, "/api/webhooks/paystack", { method: "POST", body: rawBody, headers: { "x-paystack-signature": paystackSignature(rawBody) } });
  return { status: response.status };
}

describe("subscriptions domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/subscription`)).status).toBe(401);
  });

  it("rejects a non-member of the business", async () => {
    const owner = await authenticate("Sub Owner Guard");
    const outsider = await authenticate("Sub Outsider");
    const businessId = await createBusiness(owner, "Guarded Sub Co");
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: outsider.cookies })).status).toBe(403);
  });

  it("lists the plan catalog with entitlements", async () => {
    const owner = await authenticate("Catalog Owner");
    const response = await request(server.baseUrl, "/api/subscriptions/plans", { cookie: owner.cookies });
    expect(response.status).toBe(200);
    const body = response.body as { data: { plans: { code: string }[]; entitlements: Record<string, { key: string }[]> } };
    expect(body.data.plans.map((plan) => plan.code).sort()).toEqual(["plus", "pro", "starter"]);
    expect(body.data.entitlements.starter?.some((entitlement) => entitlement.key === "team_members")).toBe(true);
  });

  it("defaults to the starter plan when a business has no subscription row, and blocks a second team invite", async () => {
    const owner = await authenticate("Starter Owner");
    const businessId = await createBusiness(owner, "Starter Co");

    const subscription = await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: owner.cookies });
    expect(subscription.status).toBe(200);
    const body = subscription.body as { data: { subscription: { planCode: string; status: string; canCancel: boolean } } };
    expect(body.data.subscription).toMatchObject({ planCode: "starter", status: "active", canCancel: false });

    const usage = await request(server.baseUrl, `/api/businesses/${businessId}/subscription/usage`, { cookie: owner.cookies });
    expect(usage.status).toBe(200);
    const usageBody = usage.body as { data: { usage: { key: string; used: number; limit: number | null }[] } };
    expect(usageBody.data.usage).toEqual([{ key: "team_members", used: 1, limit: 1, unlimited: false }]);

    const roleCreated = await request(server.baseUrl, `/api/businesses/${businessId}/team/roles`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ name: "Cashier", permissionIds: [] }) });
    const role = (roleCreated.body as { data: { role: { id: string } } }).data.role;
    const blocked = await request(server.baseUrl, `/api/businesses/${businessId}/team/invitations`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ emails: [`too-many-${randomUUID()}@example.com`], roleId: role.id }),
    });
    expect(blocked.status).toBe(400);
  });

  it("initiates a subscription checkout against a mocked Paystack API", async () => {
    const owner = await authenticate("Initiate Owner");
    const businessId = await createBusiness(owner, "Initiate Co");

    const previousKey = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "sk_test_paystack";
    const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { reference: string; plan: string };
      expect(body.plan).toBe("scripe-plus");
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ status: true, message: "ok", data: { authorization_url: "https://paystack.test/sub-pay", reference: body.reference } }),
      } as Response);
    });

    const initiated = await request(server.baseUrl, `/api/businesses/${businessId}/subscription/initiate`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ plan: "plus" }) });
    fetchSpy.mockRestore();
    process.env.PAYSTACK_SECRET_KEY = previousKey;

    expect(initiated.status).toBe(201);
    expect((initiated.body as { data: { authorizationUrl: string } }).data.authorizationUrl).toBe("https://paystack.test/sub-pay");
  });

  it("activates a subscription from the subscription.create webhook, records a paid invoice, then a recurring payment, then a failure, then disables it", async () => {
    const owner = await authenticate("Webhook Owner");
    const businessId = await createBusiness(owner, "Webhook Sub Co");
    const subscriptionCode = `SUB_${randomUUID()}`;

    const created = await postPaystackWebhook({
      event: "subscription.create",
      data: {
        subscription_code: subscriptionCode,
        customer: { customer_code: "CUS_1" },
        email_token: "tok_1",
        next_payment_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        amount: 400000,
        reference: `ref_${randomUUID()}`,
        metadata: { transaction_type: "business_subscription", business_id: businessId, plan: "plus" },
      },
    });
    expect(created.status).toBe(200);

    const afterActivate = await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: owner.cookies });
    expect((afterActivate.body as { data: { subscription: { planCode: string; status: string } } }).data.subscription).toMatchObject({ planCode: "plus", status: "active" });

    const recurring = await postPaystackWebhook({
      event: "charge.success",
      data: {
        subscription_code: subscriptionCode,
        amount: 400000,
        next_payment_date: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        reference: `ref_${randomUUID()}`,
        metadata: { business_id: businessId, plan: "plus" },
      },
    });
    expect(recurring.status).toBe(200);

    const invoices = await request(server.baseUrl, `/api/businesses/${businessId}/subscription/invoices`, { cookie: owner.cookies });
    expect((invoices.body as { data: { invoices: { status: string }[] } }).data.invoices.filter((invoice) => invoice.status === "paid")).toHaveLength(2);

    const failed = await postPaystackWebhook({
      event: "invoice.payment_failed",
      data: { reference: `ref_${randomUUID()}`, metadata: { business_id: businessId } },
    });
    expect(failed.status).toBe(200);

    const afterFailure = await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: owner.cookies });
    expect((afterFailure.body as { data: { subscription: { status: string } } }).data.subscription.status).toBe("past_due");

    const disabled = await postPaystackWebhook({ event: "subscription.disable", data: { metadata: { business_id: businessId } } });
    expect(disabled.status).toBe(200);

    const afterDisable = await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: owner.cookies });
    expect((afterDisable.body as { data: { subscription: { status: string } } }).data.subscription.status).toBe("cancelled");
  });

  it("cancels an active subscription, calling through to a mocked Paystack disable", async () => {
    const owner = await authenticate("Cancel Owner");
    const businessId = await createBusiness(owner, "Cancel Sub Co");
    const subscriptionCode = `SUB_${randomUUID()}`;

    await postPaystackWebhook({
      event: "subscription.create",
      data: {
        subscription_code: subscriptionCode,
        customer: { customer_code: "CUS_2" },
        email_token: "tok_2",
        reference: `ref_${randomUUID()}`,
        metadata: { transaction_type: "business_subscription", business_id: businessId, plan: "pro" },
      },
    });

    const previousKey = process.env.PAYSTACK_SECRET_KEY;
    process.env.PAYSTACK_SECRET_KEY = "sk_test_paystack";
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ status: true, message: "ok" }) } as Response);

    const cancelled = await request(server.baseUrl, `/api/businesses/${businessId}/subscription/cancel`, { method: "POST", cookie: owner.cookies });
    fetchSpy.mockRestore();
    process.env.PAYSTACK_SECRET_KEY = previousKey;

    expect(cancelled.status).toBe(200);
    const after = await request(server.baseUrl, `/api/businesses/${businessId}/subscription`, { cookie: owner.cookies });
    expect((after.body as { data: { subscription: { status: string } } }).data.subscription.status).toBe("cancelled");
  });

  /**
   * subscription_dunning_events is append-only (reject_immutable_change blocks UPDATE/DELETE), so a single
   * subscription's failure can't be backdated in place to simulate time passing through the grace period.
   * Each scenario below instead sets up its own subscription with the failure event already recorded at the
   * right age via a direct migratorPool insert (INSERT is unaffected by the immutability trigger).
   */
  async function setupPastDueSubscription(label: string, failureAgeInterval: string): Promise<{ businessId: string; subscriptionId: string }> {
    const owner = await authenticate(label);
    const businessId = await createBusiness(owner, label);
    const subscriptionCode = `SUB_${randomUUID()}`;

    await postPaystackWebhook({
      event: "subscription.create",
      data: { subscription_code: subscriptionCode, reference: `ref_${randomUUID()}`, metadata: { transaction_type: "business_subscription", business_id: businessId, plan: "plus" } },
    });

    const subscriptionRow = await migratorPool.query<{ id: string }>(`select id from app.business_subscriptions where "businessId" = $1`, [businessId]);
    const subscriptionId = subscriptionRow.rows[0]!.id;
    await migratorPool.query(`update app.business_subscriptions set status = 'past_due' where id = $1`, [subscriptionId]);
    await migratorPool.query(
      `insert into app.subscription_dunning_events ("businessId", "subscriptionId", "kind", "createdAt") values ($1, $2, 'payment_failed', now() - interval '${failureAgeInterval}')`,
      [businessId, subscriptionId],
    );
    return { businessId, subscriptionId };
  }

  it("sends a dunning reminder for a payment that failed within the grace period", async () => {
    const { subscriptionId } = await setupPastDueSubscription("Dunning Reminder Co", "1 day");

    const database = getDatabase();
    const sweep = await withDatabaseContext(database, anonymousPrincipal("test"), (context) => runDunningSweep(context));
    expect(sweep.remindersSent).toBeGreaterThanOrEqual(1);
    expect(sentEmails.some((email) => email.subject.includes("subscription payment failed"))).toBe(true);

    const status = await migratorPool.query<{ status: string }>(`select status from app.business_subscriptions where id = $1`, [subscriptionId]);
    expect(status.rows[0]!.status).toBe("past_due");
  });

  it("expires a subscription once its dunning grace period has lapsed", async () => {
    const { subscriptionId } = await setupPastDueSubscription("Dunning Expiry Co", "8 days");

    const database = getDatabase();
    const sweep = await withDatabaseContext(database, anonymousPrincipal("test"), (context) => runDunningSweep(context));
    expect(sweep.expired).toBeGreaterThanOrEqual(1);

    const finalStatus = await migratorPool.query<{ status: string }>(`select status from app.business_subscriptions where id = $1`, [subscriptionId]);
    expect(finalStatus.rows[0]!.status).toBe("expired");
  });
});
