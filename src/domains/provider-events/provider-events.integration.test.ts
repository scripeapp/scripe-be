import { createHmac, randomUUID } from "node:crypto";
let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBankingKybSubmitted: () => {},
    sendBankingKybApproved: () => {},
    sendBankingKybFailed: () => {},
    sendVirtualAccountIssued: () => {},
    sendVirtualAccountDeposit: () => {},
  },
}));
import { getDatabase } from "@/db/database.js";
import { withDatabaseContext } from "@/db/database-context.js";
import { withIdentity } from "@/db/principal.js";
import * as paymentsRepository from "@/domains/payments/payments.repository.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);

const PAYSTACK_SECRET = "test-paystack-secret";

let server: TestServer;
beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});
afterAll(async () => server.close());

async function authenticate(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const signupBody = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  const userId = signupBody.user?.id ?? signupBody.data?.user?.id;
  if (!userId) throw new Error("sign-up did not return a user id");
  return { userId, cookies: verified.cookies };
}

/** Builds a real business/store/channel/product/priced-cart and checks it out into a real order — same fixture path as carts-orders.integration.test.ts. */
async function createPricedOrder(cookies: string, amountMinor: number) {
  const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `Webhook Test Co ${randomUUID().slice(0, 6)}` }) });
  const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  const base = `/api/businesses/${business.id}`;

  const channelResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/channels`, { method: "POST", cookie: cookies, body: JSON.stringify({ code: `web${randomUUID().slice(0, 6)}`, name: "Web", kind: "storefront" }) });
  const channel = (channelResponse.body as { data: { channel: { id: string } } }).data.channel;

  const productResponse = await request(server.baseUrl, `${base}/products`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Webhook Widget", status: "active", variant: { name: "Default" } }) });
  const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
  await request(server.baseUrl, `${base}/prices`, { method: "POST", cookie: cookies, body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor }) });

  const cartResponse = await request(server.baseUrl, `${base}/carts`, { method: "POST", cookie: cookies, body: JSON.stringify({ storeId: business.defaultStore.id, channelId: channel.id }) });
  const cart = (cartResponse.body as { data: { cart: { id: string } } }).data.cart;
  await request(server.baseUrl, `${base}/carts/${cart.id}/lines`, { method: "POST", cookie: cookies, body: JSON.stringify({ productVariantId: variant.id, quantity: 1 }) });

  const checkout = await request(server.baseUrl, `${base}/carts/${cart.id}/checkout`, { method: "POST", cookie: cookies, body: JSON.stringify({ idempotencyKey: `checkout-${randomUUID()}` }) });
  if (checkout.status !== 201) throw new Error(`checkout ${checkout.status}: ${JSON.stringify(checkout.body)}`);
  const orderId = (checkout.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId;

  return { businessId: business.id, orderId, base };
}

function paystackSignature(rawBody: string): string {
  return createHmac("sha512", PAYSTACK_SECRET).update(rawBody).digest("hex");
}

describe("provider-events domain", () => {
  it("has no authentication middleware on webhook routes — reachable without a session", async () => {
    // A request with no session cookie AND no provider signature still hits
    // the controller (it's never turned away by requireAuth) — it just goes
    // on to fail signature verification, which also happens to answer 401.
    // So the status code alone can't distinguish "blocked by session auth"
    // from "reached the handler, signature was invalid" — both are 401.
    // What does distinguish them is the error message: requireAuth always
    // throws authRequiredError() with its default "Authentication required"
    // message, while the webhook controller throws its own
    // authRequiredError("Invalid webhook signature") for a bad signature.
    // Asserting the message rules out the session-auth path specifically.
    const response = await request(server.baseUrl, "/api/webhooks/paystack", { method: "POST", body: "{}" });
    expect(response.status).toBe(401);
    expect((response.body as { error: { message: string } }).error.message).toBe("Invalid webhook signature");
  });

  it("rejects malformed JSON with something other than a silent crash", async () => {
    const response = await request(server.baseUrl, "/api/webhooks/paystack", {
      method: "POST",
      body: "not json",
      headers: { "x-paystack-signature": "irrelevant-without-a-real-secret" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("mounts all four provider webhook routes", async () => {
    for (const provider of ["paystack", "flutterwave", "anchor", "brails"]) {
      const response = await request(server.baseUrl, `/api/webhooks/${provider}`, { method: "POST", body: "{}" });
      expect(response.status).not.toBe(404);
    }
  });

  /**
   * Regression coverage for the "column reference \"businessId\" is
   * ambiguous" bug in app.capture_checkout_payment_from_webhook (migration
   * 0029, fixed in 0037): its `returns table (..., "businessId" uuid,
   * "orderId" uuid)` OUT parameters collided with the identically-named
   * columns the function's bare SELECTs read from app.payments/app.orders,
   * so PL/pgSQL refused to run it on every single call. This drives a real
   * charge.success delivery through the actual HTTP route (raw-body
   * middleware, HMAC signature verification, the ProviderEventsService ->
   * repository -> SQL function chain, all inside a real Postgres
   * transaction) rather than calling the repository function directly, so
   * it would have caught the bug the way production traffic did.
   */
  it("captures a pending payment and issues a receipt on a real Paystack charge.success webhook", async () => {
    process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET;
    const owner = await authenticate("Webhook Owner");
    const amountMinor = 150000;
    const { businessId, orderId, base } = await createPricedOrder(owner.cookies, amountMinor);

    const externalReference = `surge_test_${randomUUID()}`;
    await withDatabaseContext(getDatabase(), withIdentity(randomUUID(), owner.userId, businessId), async (context) => {
      await paymentsRepository.record(context, businessId, owner.userId, {
        orderId,
        method: "online",
        assetCode: "NGN",
        amountMinor,
        status: "pending",
        externalReference,
        idempotencyKey: `checkout-pending-${randomUUID()}`,
      });
    });

    const rawBody = JSON.stringify({ event: "charge.success", data: { reference: externalReference, amount: amountMinor, currency: "NGN" } });
    const webhookResponse = await request(server.baseUrl, "/api/webhooks/paystack", {
      method: "POST",
      body: rawBody,
      headers: { "x-paystack-signature": paystackSignature(rawBody) },
    });
    expect(webhookResponse.status).toBe(200);
    expect((webhookResponse.body as { data: { received: boolean } }).data.received).toBe(true);

    const order = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: owner.cookies });
    expect((order.body as { data: { order: { paymentStatus: string } } }).data.order.paymentStatus).toBe("paid");

    const receipt = await request(server.baseUrl, `${base}/orders/${orderId}/receipt`, { cookie: owner.cookies });
    expect(receipt.status).toBe(200);
    expect((receipt.body as { data: { receipt: { totalMinor: string } | null } }).data.receipt).not.toBeNull();
  });

  it("is idempotent when the same charge.success webhook is redelivered", async () => {
    process.env.PAYSTACK_SECRET_KEY = PAYSTACK_SECRET;
    const owner = await authenticate("Webhook Replay Owner");
    const amountMinor = 75000;
    const { businessId, orderId, base } = await createPricedOrder(owner.cookies, amountMinor);

    const externalReference = `surge_test_${randomUUID()}`;
    await withDatabaseContext(getDatabase(), withIdentity(randomUUID(), owner.userId, businessId), async (context) => {
      await paymentsRepository.record(context, businessId, owner.userId, {
        orderId,
        method: "online",
        assetCode: "NGN",
        amountMinor,
        status: "pending",
        externalReference,
        idempotencyKey: `checkout-pending-${randomUUID()}`,
      });
    });

    const rawBody = JSON.stringify({ event: "charge.success", data: { reference: externalReference, amount: amountMinor, currency: "NGN" } });
    const signature = paystackSignature(rawBody);

    const first = await request(server.baseUrl, "/api/webhooks/paystack", { method: "POST", body: rawBody, headers: { "x-paystack-signature": signature } });
    expect(first.status).toBe(200);
    const second = await request(server.baseUrl, "/api/webhooks/paystack", { method: "POST", body: rawBody, headers: { "x-paystack-signature": signature } });
    expect(second.status).toBe(200);

    const order = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: owner.cookies });
    expect((order.body as { data: { order: { paymentStatus: string } } }).data.order.paymentStatus).toBe("paid");
  });
});
