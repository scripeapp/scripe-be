import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

async function authenticate(label: string): Promise<{ cookies: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }),
  });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return { cookies: verified.cookies };
}

interface Storefront {
  readonly base: string;
  readonly storeId: string;
  readonly channelId: string;
  readonly variantId: string;
}

async function setUpStorefront(cookies: string, amountMinor: number): Promise<Storefront> {
  const businessResponse = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: `Promo Co ${randomUUID().slice(0, 8)}` }),
  });
  const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  const base = `/api/businesses/${business.id}`;

  const channelResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/channels`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ code: `web${randomUUID().slice(0, 6)}`, name: "Web", kind: "storefront" }),
  });
  const channel = (channelResponse.body as { data: { channel: { id: string } } }).data.channel;

  const productResponse = await request(server.baseUrl, `${base}/products`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ storeId: business.defaultStore.id, name: "Promo Widget", status: "active", variant: { name: "Default" } }),
  });
  const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
  await request(server.baseUrl, `${base}/prices`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor }),
  });

  return { base, storeId: business.defaultStore.id, channelId: channel.id, variantId: variant.id };
}

async function checkout(cookies: string, storefront: Storefront, discountCode?: string): Promise<{ status: number; orderId?: string; discountMinor?: string; error?: string }> {
  const cartResponse = await request(server.baseUrl, `${storefront.base}/carts`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ storeId: storefront.storeId, channelId: storefront.channelId }),
  });
  const cart = (cartResponse.body as { data: { cart: { id: string } } }).data.cart;
  await request(server.baseUrl, `${storefront.base}/carts/${cart.id}/lines`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ productVariantId: storefront.variantId, quantity: 1 }),
  });
  const response = await request(server.baseUrl, `${storefront.base}/carts/${cart.id}/checkout`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ idempotencyKey: `checkout-${randomUUID()}`, ...(discountCode ? { discountCode } : {}) }),
  });
  if (response.status !== 201) {
    return { status: response.status, error: (response.body as { error?: { message?: string } }).error?.message };
  }
  const body = (response.body as { data: { checkout: { orderId: string; discountMinor: string } } }).data.checkout;
  return { status: response.status, orderId: body.orderId, discountMinor: body.discountMinor };
}

async function getOrder(cookies: string, base: string, orderId: string) {
  const response = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: cookies });
  return (response.body as { data: { order: { subtotalMinor: string; discountMinor: string; totalMinor: string } } }).data.order;
}

describe("promotions domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/discounts`)).status).toBe(401);
  });

  it("applies a percentage code discount at checkout and enforces its usage limit", async () => {
    const owner = await authenticate("Promo Owner");
    const storefront = await setUpStorefront(owner.cookies, 100000);

    const discountResponse = await request(server.baseUrl, `${storefront.base}/discounts`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ kind: "code", name: "Ten Off", code: "TENOFF", type: "percentage", percentageBps: 1000, maxUsage: 1 }),
    });
    expect(discountResponse.status).toBe(201);
    const discount = (discountResponse.body as { data: { discount: { id: string; usageCount: number } } }).data.discount;
    expect(discount.usageCount).toBe(0);

    const first = await checkout(owner.cookies, storefront, "tenoff");
    expect(first.status).toBe(201);
    expect(first.discountMinor).toBe("10000");
    const order = await getOrder(owner.cookies, storefront.base, first.orderId!);
    expect(order).toMatchObject({ subtotalMinor: "100000", discountMinor: "10000", totalMinor: "90000" });

    const afterFirstUse = await request(server.baseUrl, `${storefront.base}/discounts/${discount.id}`, { cookie: owner.cookies });
    expect((afterFirstUse.body as { data: { discount: { usageCount: number } } }).data.discount.usageCount).toBe(1);

    const second = await checkout(owner.cookies, storefront, "TENOFF");
    expect(second.status).toBe(400);
    expect(second.error).toMatch(/unavailable/i);
  });

  it("rejects an invalid discount code and aborts checkout entirely", async () => {
    const owner = await authenticate("Invalid Code Owner");
    const storefront = await setUpStorefront(owner.cookies, 50000);
    const result = await checkout(owner.cookies, storefront, "DOESNOTEXIST");
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/invalid discount code/i);
  });

  it("applies a fixed automatic discount without a code via a spend threshold trigger", async () => {
    const owner = await authenticate("Automatic Owner");
    const storefront = await setUpStorefront(owner.cookies, 200000);

    const created = await request(server.baseUrl, `${storefront.base}/discounts`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        kind: "automatic",
        name: "Big Spender",
        type: "fixed",
        fixedAmountMinor: "15000",
        trigger: "spend_threshold",
        triggerSpendMinor: "100000",
      }),
    });
    expect(created.status).toBe(201);

    const result = await checkout(owner.cookies, storefront);
    expect(result.status).toBe(201);
    expect(result.discountMinor).toBe("15000");
  });

  it("previews an evaluation without redeeming anything", async () => {
    const owner = await authenticate("Preview Owner");
    const storefront = await setUpStorefront(owner.cookies, 40000);
    await request(server.baseUrl, `${storefront.base}/discounts`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ kind: "code", name: "Preview Code", code: "PREVIEW5", type: "fixed", fixedAmountMinor: "5000" }),
    });

    const evaluation = await request(server.baseUrl, `${storefront.base}/discounts/evaluate`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ items: [{ productId: randomUUID(), quantity: 1, lineTotalMinor: "40000" }], code: "preview5" }),
    });
    expect(evaluation.status).toBe(200);
    const data = (evaluation.body as { data: { evaluation: { codeDiscount: { amountMinor: string } | null; discountAmountMinor: string } } }).data.evaluation;
    expect(data.codeDiscount).toMatchObject({ amountMinor: "5000" });
    expect(data.discountAmountMinor).toBe("5000");

    const discounts = await request(server.baseUrl, `${storefront.base}/discounts`, { cookie: owner.cookies });
    const previewCode = (discounts.body as { data: { discounts: { code: string | null; usageCount: number }[] } }).data.discounts.find((d) => d.code === "PREVIEW5");
    expect(previewCode?.usageCount).toBe(0);
  });

  it("rejects cross-tenant discount access", async () => {
    const owner = await authenticate("Isolated Promo Owner");
    const outsider = await authenticate("Isolated Promo Outsider");
    const storefront = await setUpStorefront(owner.cookies, 10000);
    const forbidden = await request(server.baseUrl, `${storefront.base}/discounts`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
