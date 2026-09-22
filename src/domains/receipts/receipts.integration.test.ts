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
    body: JSON.stringify({ displayName: `Receipts Co ${randomUUID().slice(0, 8)}` }),
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
    body: JSON.stringify({ storeId: business.defaultStore.id, name: "Receipt Widget", status: "active", variant: { name: "Default" } }),
  });
  const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
  await request(server.baseUrl, `${base}/prices`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor }),
  });

  return { base, storeId: business.defaultStore.id, channelId: channel.id, variantId: variant.id };
}

async function checkoutOrder(cookies: string, storefront: Storefront): Promise<string> {
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
  const checkout = await request(server.baseUrl, `${storefront.base}/carts/${cart.id}/checkout`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ idempotencyKey: `checkout-${randomUUID()}` }),
  });
  return (checkout.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId;
}

async function setUpOrder(cookies: string, amountMinor: number): Promise<{ base: string; orderId: string }> {
  const storefront = await setUpStorefront(cookies, amountMinor);
  return { base: storefront.base, orderId: await checkoutOrder(cookies, storefront) };
}

function pay(cookies: string, base: string, orderId: string, amountMinor: number) {
  return request(server.baseUrl, `${base}/payments`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ orderId, method: "card", assetCode: "NGN", amountMinor, idempotencyKey: `pay-${randomUUID()}` }),
  });
}

describe("receipts domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/receipts`)).status).toBe(401);
  });

  it("issues no receipt on a partial payment, then issues one once the order is fully paid", async () => {
    const owner = await authenticate("Receipt Owner");
    const { base, orderId } = await setUpOrder(owner.cookies, 100000);

    const partial = await pay(owner.cookies, base, orderId, 40000);
    expect(partial.status).toBe(201);

    const noReceiptYet = await request(server.baseUrl, `${base}/orders/${orderId}/receipt`, { cookie: owner.cookies });
    expect(noReceiptYet.status).toBe(404);

    const final = await pay(owner.cookies, base, orderId, 60000);
    expect(final.status).toBe(201);

    const receiptResponse = await request(server.baseUrl, `${base}/orders/${orderId}/receipt`, { cookie: owner.cookies });
    expect(receiptResponse.status).toBe(200);
    const receipt = (receiptResponse.body as { data: { receipt: { orderId: string; kind: string; number: string; totalMinor: string; currency: string } } }).data.receipt;
    expect(receipt.orderId).toBe(orderId);
    expect(receipt.kind).toBe("receipt");
    expect(receipt.number).toMatch(/^RCT-\d{6}$/);
    expect(receipt.totalMinor).toBe("100000");
    expect(receipt.currency).toBe("NGN");

    const list = await request(server.baseUrl, `${base}/receipts`, { cookie: owner.cookies });
    expect(list.status).toBe(200);
    expect((list.body as { data: { receipts: { id: string }[] } }).data.receipts.map((r) => r.id)).toContain(
      (receiptResponse.body as { data: { receipt: { id: string } } }).data.receipt.id,
    );
  });

  it("numbers receipts sequentially per business across separate orders", async () => {
    const owner = await authenticate("Sequence Owner");
    const storefront = await setUpStorefront(owner.cookies, 50000);

    const firstOrderId = await checkoutOrder(owner.cookies, storefront);
    await pay(owner.cookies, storefront.base, firstOrderId, 50000);
    const firstReceipt = (
      (await request(server.baseUrl, `${storefront.base}/orders/${firstOrderId}/receipt`, { cookie: owner.cookies })).body as {
        data: { receipt: { number: string } };
      }
    ).data.receipt;
    expect(firstReceipt.number).toBe("RCT-000001");

    const secondOrderId = await checkoutOrder(owner.cookies, storefront);
    await pay(owner.cookies, storefront.base, secondOrderId, 50000);
    const secondReceipt = (
      (await request(server.baseUrl, `${storefront.base}/orders/${secondOrderId}/receipt`, { cookie: owner.cookies })).body as {
        data: { receipt: { number: string } };
      }
    ).data.receipt;
    expect(secondReceipt.number).toBe("RCT-000002");
  });

  it("rejects fetching another business's receipts", async () => {
    const owner = await authenticate("Isolated Owner");
    const outsider = await authenticate("Isolated Outsider");
    const { base } = await setUpOrder(owner.cookies, 10000);
    const forbidden = await request(server.baseUrl, `${base}/receipts`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
