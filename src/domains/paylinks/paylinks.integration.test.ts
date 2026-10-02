import { createHmac, randomUUID } from "node:crypto";
import type * as EmailModule from "@/shared/email.js";

let verificationMessages: { to: string; code: string }[];
let transactionalEmails: { to: string; subject: string }[];

jest.mock("@/shared/email.js", () => ({
  // escapeHtml stays real: the paylink receipt emails use it.
  ...jest.requireActual<typeof EmailModule>("@/shared/email.js"),
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendTransactional: (params: { to: string; subject: string }) => transactionalEmails.push({ to: params.to, subject: params.subject }),
  },
}));

import { Pool } from "pg";
import { getDatabase } from "@/db/database.js";
import { reconcilePendingPaylinkPayments } from "@/domains/paylinks/paylinks.service.js";
import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type HttpResponse, type TestServer } from "@/test-support/http.js";
import type { PaylinkPaymentSummary, PaylinkSummary, PublicCheckoutResult, PublicCheckoutStatus, PublicPaylink } from "@/domains/paylinks/paylinks.types.js";

/** The `data` envelope of every API response, typed by what each endpoint returns. */
interface ResponseData {
  paylink: PaylinkSummary & PublicPaylink;
  paylinks: PaylinkSummary[];
  totalCount: number;
  checkout: PublicCheckoutResult;
  status: PublicCheckoutStatus;
  payments: PaylinkPaymentSummary[];
}

function data(response: HttpResponse): ResponseData {
  return (response.body as { data: ResponseData }).data;
}

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
// Privileged setup the API can't do (backdating a payment, placing a risk hold), as in subscriptions' tests.
let migratorPool: Pool;

beforeAll(async () => {
  verificationMessages = [];
  transactionalEmails = [];
  // Each public request below carries its own X-Forwarded-For so the
  // per-IP rate limits of one test never spill into another.
  process.env.TRUST_PROXY_HOPS = "1";
  // No real Paystack in tests: the gateway simulates checkout and confirms
  // exactly the amount it was initialized with.
  process.env.PAYSTACK_MOCK_CHECKOUT = "true";
  delete process.env.PAYSTACK_SECRET_KEY;
  server = await startTestServer();
  const environment = loadEnvironment();
  migratorPool = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});

afterAll(async () => {
  await migratorPool.end();
  await server.close();
});

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

async function createBusinessWithStore(cookies: string, name: string): Promise<{ id: string; storeId: string }> {
  const res = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: name }) });
  if (res.status !== 201) throw new Error(`Business creation failed: ${res.status}`);
  const business = (res.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  return { id: business.id, storeId: business.defaultStore.id };
}

async function createBusiness(cookies: string, name: string): Promise<string> {
  const res = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: name }),
  });
  if (res.status !== 201) throw new Error(`Business creation failed: ${res.status}`);
  return (res.body as { data: { business: { id: string } } }).data.business.id;
}

describe("paylinks domain", () => {
  it("requires authentication for business paylink endpoints", async () => {
    const fakeBusinessId = randomUUID();
    const res = await request(server.baseUrl, `/api/businesses/${fakeBusinessId}/paylinks`);
    expect(res.status).toBe(401);
  });

  it("creates a payment link with generated slug, lists, updates, and archives it", async () => {
    const owner = await authenticate("Paylink Owner");
    const businessId = await createBusiness(owner.cookies, "Paylink Store");
    const base = `/api/businesses/${businessId}/paylinks`;

    // 1. Create Paylink
    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Registration Fee",
        mode: "take_payment",
        amountType: "fixed",
        amountMinor: 500000, // ₦5,000
        description: "Annual membership fee",
        collectName: true,
        collectPhone: true,
      }),
    });

    expect(createRes.status).toBe(201);
    const paylink = data(createRes).paylink;
    expect(paylink.id).toBeDefined();
    expect(paylink.slug).toHaveLength(8);
    expect(paylink.title).toBe("Registration Fee");
    expect(paylink.amountMinor).toBe("500000");
    expect(paylink.status).toBe("active");

    // 2. List Paylinks
    const listRes = await request(server.baseUrl, base, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect(listRes.status).toBe(200);
    const listData = data(listRes);
    expect(listData.totalCount).toBe(1);
    expect(listData.paylinks[0]?.id).toBe(paylink.id);

    // 3. Get Paylink Details
    const getRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect(getRes.status).toBe(200);
    expect(data(getRes).paylink.title).toBe("Registration Fee");

    // 4. Update Paylink (pause)
    const updateRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Registration Fee 2026",
        status: "paused",
      }),
    });
    expect(updateRes.status).toBe(200);
    expect(data(updateRes).paylink.status).toBe("paused");
    expect(data(updateRes).paylink.title).toBe("Registration Fee 2026");

    // 5. Archive Paylink
    const archiveRes = await request(server.baseUrl, `${base}/${paylink.id}`, {
      method: "DELETE",
      cookie: owner.cookies,
    });
    expect(archiveRes.status).toBe(200);

    // 6. Archived link is excluded from list
    const listAfterArchive = await request(server.baseUrl, base, {
      method: "GET",
      cookie: owner.cookies,
    });
    expect(data(listAfterArchive).totalCount).toBe(0);
  });

  it("handles custom slug creation and enforces unique slugs and reserved names", async () => {
    const owner = await authenticate("Slug Owner");
    const businessId = await createBusiness(owner.cookies, "Slug Store");
    const base = `/api/businesses/${businessId}/paylinks`;

    const uniqueSlug = `summer-camp-${randomUUID().slice(0, 8)}`;

    // 1. Create with custom slug
    const createRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Summer Camp",
        mode: "take_payment",
        amountType: "customer_sets",
        minAmountMinor: 100000,
        customSlug: uniqueSlug,
      }),
    });
    expect(createRes.status).toBe(201);
    expect(data(createRes).paylink.slug).toBe(uniqueSlug);

    // 2. Reject duplicate slug
    const duplicateRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Summer Camp Duplicate",
        mode: "take_payment",
        amountType: "customer_sets",
        customSlug: uniqueSlug,
      }),
    });
    expect(duplicateRes.status).toBe(409);

    // 3. Reject reserved slug
    const reservedRes = await request(server.baseUrl, base, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Admin link",
        mode: "take_payment",
        amountType: "customer_sets",
        customSlug: "admin",
      }),
    });
    expect(reservedRes.status).toBe(400);
  });

  it("rejects cross-tenant access to another business's paylink", async () => {
    const owner1 = await authenticate("Owner One");
    const biz1 = await createBusiness(owner1.cookies, "Biz One");

    const owner2 = await authenticate("Owner Two");
    const biz2 = await createBusiness(owner2.cookies, "Biz Two");

    // Owner 1 creates link
    const createRes = await request(server.baseUrl, `/api/businesses/${biz1}/paylinks`, {
      method: "POST",
      cookie: owner1.cookies,
      body: JSON.stringify({
        title: "Secret Fundraiser",
        mode: "donation",
        amountType: "customer_sets",
      }),
    });
    expect(createRes.status).toBe(201);
    const linkId = data(createRes).paylink.id;

    // Owner 2 tries to access Biz 1's link
    const crossGet = await request(server.baseUrl, `/api/businesses/${biz2}/paylinks/${linkId}`, {
      method: "GET",
      cookie: owner2.cookies,
    });
    expect(crossGet.status).toBe(404);
  });

  it("serves public link and completes public guest checkout flow", async () => {
    const owner = await authenticate("Public Pay Owner");
    const businessId = await createBusiness(owner.cookies, "Public Market");

    const publicSlug = `market-buy-${randomUUID().slice(0, 8)}`;

    const createRes = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        title: "Premium Artisan Bread",
        mode: "take_payment",
        amountType: "fixed",
        amountMinor: 350000, // ₦3,500
        description: "Freshly baked organic sourdough loaf",
        customSlug: publicSlug,
      }),
    });
    expect(createRes.status).toBe(201);

    // 1. Public Read (No cookies / anonymous)
    const publicGet = await request(server.baseUrl, `/api/public/paylinks/${publicSlug}`);
    expect(publicGet.status).toBe(200);
    const publicLink = data(publicGet).paylink;
    expect(publicLink.title).toBe("Premium Artisan Bread");
    expect(publicLink.businessName).toBe("Public Market");
    expect(publicLink.amountMinor).toBe("350000");

    // 2. Public Guest Checkout
    const checkoutRes = await request(server.baseUrl, `/api/public/paylinks/${publicSlug}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        customerName: "Babajide Cole",
        customerEmail: "babajide@example.com",
        customerPhone: "+2348099887766",
        quantity: 2, // ignored: only product links sell more than one unit
        idempotencyKey: `idemp_${Date.now()}`,
      }),
    });
    expect(checkoutRes.status).toBe(201);
    const checkoutData = data(checkoutRes).checkout;
    expect(checkoutData.orderId).toBeDefined();
    expect(checkoutData.paymentId).toBeDefined();
    expect(checkoutData.reference).toBeDefined();
    expect(checkoutData.authorizationUrl).toBeDefined();

    // 3. Public Checkout Status Poll
    const statusRes = await request(
      server.baseUrl,
      `/api/public/paylinks/checkout/${checkoutData.reference}`,
    );
    expect(statusRes.status).toBe(200);
    const statusData = data(statusRes).status;
    expect(statusData.reference).toBe(checkoutData.reference);
    expect(statusData.amountMinor).toBe("350000");
  });

  async function createLink(cookies: string, businessId: string, body: Record<string, unknown>): Promise<{ id: string; slug: string }> {
    const res = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks`, {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ customSlug: `t-${randomUUID().slice(0, 12)}`, ...body }),
    });
    if (res.status !== 201) throw new Error(`Paylink creation failed: ${res.status} ${JSON.stringify(res.body)}`);
    const paylink = data(res).paylink;
    return { id: paylink.id, slug: paylink.slug };
  }

  const publicHeaders = () => ({ "x-forwarded-for": `10.${randomInt255()}.${randomInt255()}.${randomInt255()}` });
  const randomInt255 = () => Math.floor(Math.random() * 255);

  it("checks out without a client idempotency key, replays a repeated key, and never trusts the client's amount on fixed links", async () => {
    const owner = await authenticate("Idempotent Owner");
    const businessId = await createBusiness(owner.cookies, "Idempotent Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Consultation", mode: "take_payment", amountType: "fixed", amountMinor: 500000 });
    const headers = publicHeaders();

    // The pay page does not send a key: this used to fail on payments' NOT NULL idempotencyKey.
    const noKey = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Ada", customerEmail: "ada@example.com", customerPhone: "+2348011111111", amountMinor: 100 }),
    });
    expect(noKey.status).toBe(201);
    const noKeyRef = data(noKey).checkout.reference;
    const noKeyStatus = await request(server.baseUrl, `/api/public/paylinks/checkout/${noKeyRef}`, { headers });
    expect(data(noKeyStatus).status.amountMinor).toBe("500000");

    const body = JSON.stringify({ customerName: "Ada", customerEmail: "ada@example.com", customerPhone: "+2348011111111", idempotencyKey: `key-${randomUUID()}` });
    const first = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, { method: "POST", headers, body });
    const second = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, { method: "POST", headers, body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(data(second).checkout.reference).toBe(data(first).checkout.reference);
    expect(data(second).checkout.authorizationUrl).toBe(data(first).checkout.authorizationUrl);
  });

  it("settles a confirmed payment on the status poll: order paid, link stats updated, receipt and merchant emails sent", async () => {
    const owner = await authenticate("Settle Owner");
    const businessId = await createBusiness(owner.cookies, "Settle Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Donate", mode: "donation", amountType: "customer_sets", minAmountMinor: 100000 });
    const headers = publicHeaders();

    const tooSmall = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Bola", customerEmail: "bola@example.com", customerPhone: "+2348022222222", amountMinor: 50000 }),
    });
    expect(tooSmall.status).toBe(400);

    const customerEmail = `bola-${randomUUID().slice(0, 8)}@example.com`;
    const checkout = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Bola", customerEmail, customerPhone: "+2348022222222", amountMinor: 250000 }),
    });
    expect(checkout.status).toBe(201);
    const reference = data(checkout).checkout.reference;

    // The dev gateway mock confirms the amount it was initialized with.
    const status = await request(server.baseUrl, `/api/public/paylinks/checkout/${reference}`, { headers });
    expect(data(status).status.status).toBe("paid");

    const payments = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks/${link.id}/payments`, { cookie: owner.cookies });
    const payment = data(payments).payments.find((p) => p.reference === reference);
    expect(payment?.status).toBe("captured");
    expect(payment?.customerEmail).toBe(customerEmail);

    const detail = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks/${link.id}`, { cookie: owner.cookies });
    expect(data(detail).paylink.paymentCount).toBe(1);
    expect(data(detail).paylink.totalCollectedMinor).toBe("250000");

    expect(transactionalEmails.some((email) => email.to === customerEmail && email.subject.includes("Receipt"))).toBe(true);
    expect(transactionalEmails.some((email) => email.subject.includes('"Donate"'))).toBe(true);

    const notifications = await request(server.baseUrl, "/api/me/notifications", { cookie: owner.cookies });
    const items = (notifications.body as { data: { notifications: { type: string; title: string }[] } }).data.notifications;
    expect(items.some((item) => item.type === "paylink.payment_received" && item.title.includes("Donate"))).toBe(true);
  });

  it("refuses to capture a webhook charge that is smaller than the payment", async () => {
    const owner = await authenticate("Webhook Owner");
    const businessId = await createBusiness(owner.cookies, "Webhook Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Ticket", mode: "take_payment", amountType: "fixed", amountMinor: 900000, collectPhone: false });
    const headers = publicHeaders();
    const checkout = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Chidi", customerEmail: "chidi@example.com" }),
    });
    const reference = data(checkout).checkout.reference;

    const secret = "sk_test_webhook_secret";
    process.env.PAYSTACK_SECRET_KEY = secret;
    try {
      const send = async (amount: number) => {
        const raw = JSON.stringify({ event: "charge.success", data: { reference, amount, currency: "NGN", id: randomUUID() } });
        return request(server.baseUrl, "/api/webhooks/paystack", {
          method: "POST",
          body: raw,
          headers: { "x-paystack-signature": createHmac("sha512", secret).update(raw).digest("hex") },
        });
      };
      await send(100);
    } finally {
      delete process.env.PAYSTACK_SECRET_KEY;
    }

    const payments = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks/${link.id}/payments`, { cookie: owner.cookies });
    const payment = data(payments).payments.find((p) => p.reference === reference);
    expect(payment?.status).toBe("pending");
  });

  it("rejects unsafe redirect URLs, foreign image keys, and fixed links without an amount", async () => {
    const owner = await authenticate("Validation Owner");
    const businessId = await createBusiness(owner.cookies, "Validation Shop");
    const post = (body: Record<string, unknown>) =>
      request(server.baseUrl, `/api/businesses/${businessId}/paylinks`, {
        method: "POST",
        cookie: owner.cookies,
        body: JSON.stringify({ title: "X", mode: "take_payment", amountType: "fixed", amountMinor: 1000, ...body }),
      });

    expect((await post({ redirectUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ redirectUrl: "http://example.com/thanks" })).status).toBe(400);
    expect((await post({ redirectUrl: "https://example.com/thanks" })).status).toBe(201);
    expect((await post({ imageKey: "uploads/compliance_document/someone-elses-file.pdf" })).status).toBe(400);
    expect((await post({ amountMinor: null })).status).toBe(400);
  });

  it("requires the phone and address a link asks for, and stores the address on the order", async () => {
    const owner = await authenticate("Address Owner");
    const businessId = await createBusiness(owner.cookies, "Address Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Delivery", mode: "take_payment", amountType: "fixed", amountMinor: 150000, collectAddress: true });
    const headers = publicHeaders();
    const checkout = (body: Record<string, unknown>) =>
      request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ customerName: "Dayo", customerEmail: "dayo@example.com", ...body }),
      });

    expect((await checkout({ deliveryAddress: { streetAddress: "1 Allen Ave" } })).status).toBe(400);
    expect((await checkout({ customerPhone: "+2348033333333" })).status).toBe(400);
    const ok = await checkout({ customerPhone: "+2348033333333", deliveryAddress: { streetAddress: "1 Allen Ave", city: "Ikeja", state: "Lagos" } });
    expect(ok.status).toBe(201);

    const payments = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks/${link.id}/payments`, { cookie: owner.cookies });
    const payment = data(payments).payments[0];
    expect(payment?.deliveryAddress).toEqual({ streetAddress: "1 Allen Ave", city: "Ikeja", state: "Lagos" });
    expect(payment?.customerPhone).toBe("+2348033333333");
  });

  it("does not expose one business's links to another signed-in business through RLS", async () => {
    const ownerA = await authenticate("Rls Owner A");
    const businessA = await createBusiness(ownerA.cookies, "Rls A");
    await createLink(ownerA.cookies, businessA, { title: "Secret", mode: "take_payment", amountType: "fixed", amountMinor: 1000 });
    const ownerB = await authenticate("Rls Owner B");
    const businessB = await createBusiness(ownerB.cookies, "Rls B");
    const list = await request(server.baseUrl, `/api/businesses/${businessB}/paylinks`, { cookie: ownerB.cookies });
    expect(data(list).paylinks).toHaveLength(0);
  });

  it("rate-limits checkout attempts from one client", async () => {
    const owner = await authenticate("Limit Owner");
    const businessId = await createBusiness(owner.cookies, "Limit Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Limit", mode: "take_payment", amountType: "fixed", amountMinor: 1000, collectPhone: false });
    const headers = publicHeaders();
    // Fixed one-minute windows: start well clear of a boundary.
    const secondsIntoWindow = new Date().getSeconds();
    if (secondsIntoWindow > 50) await new Promise((resolve) => setTimeout(resolve, (61 - secondsIntoWindow) * 1000));
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ customerName: "Eko", customerEmail: "eko@example.com" }),
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  }, 30_000);

  it("sells several units of a product at the catalog price, which the client cannot change", async () => {
    const owner = await authenticate("Product Owner");
    const business = await createBusinessWithStore(owner.cookies, "Product Shop");
    const base = `/api/businesses/${business.id}`;
    const product = (await request(server.baseUrl, `${base}/products`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ storeId: business.storeId, name: "Vitamin Pack" }) })).body as { data: { product: { id: string } } };
    const variants = await request(server.baseUrl, `${base}/products/${product.data.product.id}/variants`, {
      method: "PUT",
      cookie: owner.cookies,
      body: JSON.stringify({ variants: [{ clientKey: "default", name: "Default", priceMinor: 1_250_000 }] }),
    });
    const variantId = (variants.body as { data: { variants: { id: string }[] } }).data.variants[0]?.id;
    expect(variantId).toBeDefined();

    // No amount sent: the API takes the catalog price.
    const link = await createLink(owner.cookies, business.id, { title: "Vitamin Pack", mode: "product", amountType: "fixed", productVariantId: variantId, collectPhone: false });
    const headers = publicHeaders();
    const checkout = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Funke", customerEmail: "funke@example.com", quantity: 3, amountMinor: 100 }),
    });
    expect(checkout.status).toBe(201);
    const status = await request(server.baseUrl, `/api/public/paylinks/checkout/${data(checkout).checkout.reference}`, { headers });
    expect(data(status).status.amountMinor).toBe("3750000");

    const tooMany = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Funke", customerEmail: "funke@example.com", quantity: 101 }),
    });
    expect(tooMany.status).toBe(400);
  });

  it("enforces the plan's active-link limit on create and on re-activation", async () => {
    const owner = await authenticate("Limit Plan Owner");
    const businessId = await createBusiness(owner.cookies, "Limit Plan Shop");
    // A business with no subscription is on starter: 10 active links.
    for (let i = 0; i < 10; i++) {
      await createLink(owner.cookies, businessId, { title: `L${i}`, mode: "take_payment", amountType: "customer_sets" });
    }
    const eleventh = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ title: "L10", mode: "take_payment", amountType: "customer_sets" }),
    });
    expect(eleventh.status).toBe(400);

    // Drafts don't count, but activating one past the limit is refused.
    const draft = await createLink(owner.cookies, businessId, { title: "Draft", mode: "take_payment", amountType: "customer_sets", status: "paused" });
    const activate = await request(server.baseUrl, `/api/businesses/${businessId}/paylinks/${draft.id}`, {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ status: "active" }),
    });
    expect(activate.status).toBe(400);
  });

  it("stops taking payments while the business is under a risk hold", async () => {
    const owner = await authenticate("Hold Owner");
    const businessId = await createBusiness(owner.cookies, "Hold Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Held", mode: "take_payment", amountType: "fixed", amountMinor: 10000, collectPhone: false });
    await migratorPool.query(`insert into app.transaction_holds ("entityType", "entityId", "reason", "createdBy") values ('business', $1, 'test hold', $2)`, [businessId, owner.userId]);

    const headers = publicHeaders();
    const view = await request(server.baseUrl, `/api/public/paylinks/${link.slug}`, { headers });
    expect(data(view).paylink.acceptingPayments).toBe(false);
    const checkout = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
      method: "POST",
      headers,
      body: JSON.stringify({ customerName: "Gbenga", customerEmail: "gbenga@example.com" }),
    });
    expect(checkout.status).toBe(409);
  });

  it("reconciles payments left pending: settles confirmed ones and abandons day-old ones", async () => {
    const owner = await authenticate("Reconcile Owner");
    const businessId = await createBusiness(owner.cookies, "Reconcile Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Reconcile", mode: "take_payment", amountType: "fixed", amountMinor: 20000, collectPhone: false });
    const headers = publicHeaders();
    const pay = async () => {
      const res = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ customerName: "Halima", customerEmail: "halima@example.com" }),
      });
      return data(res).checkout.reference;
    };
    const confirmed = await pay(); // the mock gateway knows this one: it verifies as paid
    const abandoned = await pay();
    await migratorPool.query(`update app.payments set "createdAt" = now() - interval '20 minutes' where "externalReference" = $1`, [confirmed]);
    // An unknown reference to the gateway, created over a day ago.
    await migratorPool.query(`update app.payments set "createdAt" = now() - interval '25 hours', "externalReference" = $2 where "externalReference" = $1`, [abandoned, `${abandoned}_x`]);

    await reconcilePendingPaylinkPayments(getDatabase());

    const statuses = await migratorPool.query<{ externalReference: string; status: string }>(
      `select "externalReference", "status" from app.payments where "externalReference" = any($1)`,
      [[confirmed, `${abandoned}_x`]],
    );
    const byRef = Object.fromEntries(statuses.rows.map((row) => [row.externalReference, row.status]));
    expect(byRef[confirmed]).toBe("captured");
    expect(byRef[`${abandoned}_x`]).toBe("failed");
  });

  it("with real Paystack configured, refuses payment until the business has a payout account", async () => {
    const owner = await authenticate("Payout Owner");
    const businessId = await createBusiness(owner.cookies, "Payout Shop");
    const link = await createLink(owner.cookies, businessId, { title: "Needs payouts", mode: "take_payment", amountType: "fixed", amountMinor: 10000, collectPhone: false });
    const headers = publicHeaders();

    process.env.PAYSTACK_SECRET_KEY = "sk_test_no_network_needed";
    try {
      const view = await request(server.baseUrl, `/api/public/paylinks/${link.slug}`, { headers });
      expect(data(view).paylink.acceptingPayments).toBe(false);
      // Refused before any Paystack call: the business has no virtual account to settle to.
      const checkout = await request(server.baseUrl, `/api/public/paylinks/${link.slug}/checkout`, {
        method: "POST",
        headers,
        body: JSON.stringify({ customerName: "Ife", customerEmail: "ife@example.com" }),
      });
      expect(checkout.status).toBe(409);
    } finally {
      delete process.env.PAYSTACK_SECRET_KEY;
    }
  });
});
