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

interface Setup {
  readonly base: string;
  readonly orderId: string;
  readonly orderLineId: string;
  readonly inventoryItemId: string;
  readonly inventoryLocationId: string;
}

async function setUpOrderWithInventory(cookies: string, quantity: number): Promise<Setup> {
  const businessResponse = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: `Returns Co ${randomUUID().slice(0, 8)}` }),
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
    body: JSON.stringify({ storeId: business.defaultStore.id, name: "Return Widget", status: "active", variant: { name: "Default" } }),
  });
  const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
  await request(server.baseUrl, `${base}/prices`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor: 50000 }),
  });

  const locationResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/locations`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ name: "Main Warehouse" }),
  });
  const location = (locationResponse.body as { data: { location: { id: string } } }).data.location;

  const itemResponse = await request(server.baseUrl, `${base}/inventory/items`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ name: "Return Widget", variantId: variant.id }),
  });
  const item = (itemResponse.body as { data: { item: { id: string } } }).data.item;

  const inventoryLocationResponse = await request(server.baseUrl, `${base}/inventory/locations`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ locationId: location.id, name: "Main Warehouse" }),
  });
  const inventoryLocation = (inventoryLocationResponse.body as { data: { location: { id: string } } }).data.location;

  const cartResponse = await request(server.baseUrl, `${base}/carts`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ storeId: business.defaultStore.id, channelId: channel.id }),
  });
  const cart = (cartResponse.body as { data: { cart: { id: string } } }).data.cart;
  await request(server.baseUrl, `${base}/carts/${cart.id}/lines`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ productVariantId: variant.id, quantity }),
  });
  const checkout = await request(server.baseUrl, `${base}/carts/${cart.id}/checkout`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ idempotencyKey: `checkout-${randomUUID()}` }),
  });
  const orderId = (checkout.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId;

  const order = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: cookies });
  const orderLineId = (order.body as { data: { order: { lines: { id: string }[] } } }).data.order.lines[0]!.id;

  return { base, orderId, orderLineId, inventoryItemId: item.id, inventoryLocationId: inventoryLocation.id };
}

async function balanceOf(cookies: string, base: string, inventoryItemId: string, inventoryLocationId: string): Promise<string> {
  const response = await request(server.baseUrl, `${base}/inventory/balances?inventoryItemId=${inventoryItemId}&inventoryLocationId=${inventoryLocationId}`, { cookie: cookies });
  const balances = (response.body as { data: { balances: { onHand: string }[] } }).data.balances;
  return balances[0]?.onHand ?? "0";
}

describe("returns domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/returns`)).status).toBe(401);
  });

  it("records a return, computes the refundable amount, and restocks the returned quantity", async () => {
    const owner = await authenticate("Returns Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 3);

    expect(await balanceOf(owner.cookies, setup.base, setup.inventoryItemId, setup.inventoryLocationId)).toBe("0");

    const created = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        orderId: setup.orderId,
        reason: "Customer changed their mind",
        inventoryLocationId: setup.inventoryLocationId,
        lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: true }],
      }),
    });
    expect(created.status).toBe(201);
    const returned = (created.body as { data: { return: { refundableAmountMinor: string; lines: { restocked: boolean; amountMinor: string }[] } } }).data.return;
    expect(returned.refundableAmountMinor).toBe("50000");
    expect(returned.lines).toEqual([expect.objectContaining({ restocked: true, amountMinor: "50000" })]);

    // Stock quantities are numeric(20,6); the balances endpoint returns the
    // full-precision string here, same as inventory.integration.test.ts's
    // "available" assertion ("7.000000") — not trimmed to "1".
    expect(await balanceOf(owner.cookies, setup.base, setup.inventoryItemId, setup.inventoryLocationId)).toBe("1.000000");

    const list = await request(server.baseUrl, `${setup.base}/returns?orderId=${setup.orderId}`, { cookie: owner.cookies });
    expect((list.body as { data: { returns: { id: string }[] } }).data.returns).toHaveLength(1);
  });

  it("rejects returning more than the order line's remaining quantity, across multiple returns", async () => {
    const owner = await authenticate("Overreturn Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 2);

    const first = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Partial return", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: false }] }),
    });
    expect(first.status).toBe(201);

    const second = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Too much", lines: [{ orderLineId: setup.orderLineId, quantity: 2, condition: "sellable", restock: false }] }),
    });
    expect(second.status).toBe(409);
  });

  it("does not touch inventory when a line is not restocked", async () => {
    const owner = await authenticate("No Restock Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1);

    const created = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Defective, discarded", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "defective", restock: false }] }),
    });
    expect(created.status).toBe(201);
    expect(await balanceOf(owner.cookies, setup.base, setup.inventoryItemId, setup.inventoryLocationId)).toBe("0");
  });

  it("requires inventoryLocationId when restocking", async () => {
    const owner = await authenticate("Missing Location Owner");
    const setup = await setUpOrderWithInventory(owner.cookies, 1);
    const created = await request(server.baseUrl, `${setup.base}/returns`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ orderId: setup.orderId, reason: "Wants restock", lines: [{ orderLineId: setup.orderLineId, quantity: 1, condition: "sellable", restock: true }] }),
    });
    expect(created.status).toBe(400);
  });

  it("rejects cross-tenant return access", async () => {
    const owner = await authenticate("Isolated Return Owner");
    const outsider = await authenticate("Isolated Return Outsider");
    const setup = await setUpOrderWithInventory(owner.cookies, 1);
    const forbidden = await request(server.baseUrl, `${setup.base}/returns`, { cookie: outsider.cookies });
    expect(forbidden.status).toBe(403);
  });
});
