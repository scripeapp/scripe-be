import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));
import { request, startTestServer, type HttpResponse, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
jest.setTimeout(60_000);

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});
afterAll(async () => server.close());

interface Owner {
  cookies: string;
  businessId: string;
  storeId: string;
}

interface TillFixture extends Owner {
  locationId: string;
  registerId: string;
  productId: string;
  cashierId: string;
}

const data = <T>(response: HttpResponse): T => (response.body as { data: T }).data;

async function owner(label: string): Promise<Owner> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) });
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  const cookies = verified.cookies;
  const business = data<{ business: { id: string; defaultStore: { id: string } } }>(
    await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `${label} Kitchen` }) }),
  ).business;
  return { cookies, businessId: business.id, storeId: business.defaultStore.id };
}

async function post<T>(fix: Owner, path: string, body: unknown, method = "POST"): Promise<HttpResponse & { json: T }> {
  const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}${path}`, { method, cookie: fix.cookies, body: JSON.stringify(body) });
  return Object.assign(response, { json: (response.body as { data: T }).data });
}

/** A draft store (never published) with one priced product, a register, and a till-only cashier. */
async function tillFixture(label: string): Promise<TillFixture> {
  const fix = await owner(label);
  const locationId = (await post<{ location: { id: string } }>(fix, `/stores/${fix.storeId}/locations`, { name: "Counter", kind: "branch" })).json.location.id;
  const registerId = (await post<{ register: { id: string } }>(fix, `/stores/${fix.storeId}/registers`, { locationId, name: "Front till" })).json.register.id;
  const product = (await post<{ product: { id: string; variants: { id: string }[] } }>(fix, "/products", { storeId: fix.storeId, name: "Suya Wrap", status: "active" })).json.product;
  await post(fix, "/prices", { productVariantId: product.variants[0]!.id, assetCode: "NGN", amountMinor: 250000 });

  const partyId = (await post<{ party: { id: string } }>(fix, "/parties", { kind: "person", displayName: "Tobi Till" })).json.party.id;
  const cashierId = (await post<{ staff: { id: string } }>(fix, "/staff", { partyId, displayName: "Tobi", isBookable: false })).json.staff.id;
  const till = await post(fix, `/staff/${cashierId}/till`, { enabled: true, pin: "4821" }, "PUT");
  if (till.status !== 200) throw new Error(`till access failed ${till.status}`);
  return { ...fix, locationId, registerId, productId: product.id, cashierId };
}

async function pairDevice(fix: TillFixture): Promise<string> {
  const code = (await post<{ code: string }>(fix, `/stores/${fix.storeId}/registers/${fix.registerId}/pairing-code`, {})).json.code;
  const paired = await request(server.baseUrl, "/api/pos/device/pair", { method: "POST", body: JSON.stringify({ pairing_code: code, label: "Counter iPad" }) });
  if (paired.status !== 200) throw new Error(`pair failed ${paired.status}`);
  return data<{ deviceToken: string }>(paired).deviceToken;
}

const onDevice = (token: string, path: string, body?: unknown) =>
  request(server.baseUrl, `/api/pos/device${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { "x-register-device-token": token },
  });

describe("cashier devices", () => {
  it("gives staff till access with a unique 4-digit PIN and never returns the hash", async () => {
    const fix = await tillFixture("Pin Owner");
    const partyId = (await post<{ party: { id: string } }>(fix, "/parties", { kind: "person", displayName: "Ada Till" })).json.party.id;
    const otherId = (await post<{ staff: { id: string } }>(fix, "/staff", { partyId, displayName: "Ada", isBookable: false })).json.staff.id;

    expect((await post(fix, `/staff/${otherId}/till`, { enabled: true }, "PUT")).status).toBe(400);
    expect((await post(fix, `/staff/${otherId}/till`, { enabled: true, pin: "12" }, "PUT")).status).toBe(400);
    expect((await post(fix, `/staff/${otherId}/till`, { enabled: true, pin: "4821" }, "PUT")).status).toBe(409);
    const ok = await post<{ staff: Record<string, unknown> }>(fix, `/staff/${otherId}/till`, { enabled: true, pin: "7303", locationId: fix.locationId }, "PUT");
    expect(ok.status).toBe(200);
    expect(ok.json.staff).toMatchObject({ tillEnabled: true, hasPin: true, tillLocationId: fix.locationId, isBookable: false });
    expect(JSON.stringify(ok.body)).not.toContain("scrypt");
  });

  it("pairs with a one-time code and signs requests in as the device", async () => {
    const fix = await tillFixture("Pair Owner");
    const created = await post<{ code: string; expiresAt: string }>(fix, `/stores/${fix.storeId}/registers/${fix.registerId}/pairing-code`, {});
    expect(created.status).toBe(201);
    expect(created.json.code).toMatch(/^\d{16}$/);

    const wrong = await request(server.baseUrl, "/api/pos/device/pair", { method: "POST", body: JSON.stringify({ pairing_code: "0000000000000000" }) });
    expect(wrong.status).toBe(400);

    const paired = await request(server.baseUrl, "/api/pos/device/pair", { method: "POST", body: JSON.stringify({ pairing_code: created.json.code.replace(/(\d{4})/g, "$1-") }) });
    expect(paired.status).toBe(200);
    const token = data<{ deviceToken: string; session: { register: { id: string }; branch: { id: string } } }>(paired);
    expect(token.session.register.id).toBe(fix.registerId);
    expect(token.session.branch.id).toBe(fix.locationId);

    const reused = await request(server.baseUrl, "/api/pos/device/pair", { method: "POST", body: JSON.stringify({ pairing_code: created.json.code }) });
    expect(reused.status).toBe(400);

    expect((await onDevice(token.deviceToken, "/session")).status).toBe(200);
    expect((await onDevice("not-a-token", "/session")).status).toBe(401);
    expect((await request(server.baseUrl, "/api/pos/device/session")).status).toBe(401);

    const devices = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers/${fix.registerId}/devices`, { cookie: fix.cookies });
    expect(data<{ devices: { label: string; status: string }[] }>(devices).devices).toEqual([expect.objectContaining({ label: "Front till", status: "active" })]);

    const unpaired = await post<{ revoked: number }>(fix, `/stores/${fix.storeId}/registers/${fix.registerId}/unpair`, {});
    expect(unpaired.json.revoked).toBe(1);
    expect((await onDevice(token.deviceToken, "/session")).status).toBe(401);
  });

  it("unlocks by PIN and locks out repeated guesses", async () => {
    const fix = await tillFixture("Unlock Owner");
    const token = await pairDevice(fix);
    const unlocked = await onDevice(token, "/unlock", { pin: "4821" });
    expect(unlocked.status).toBe(200);
    expect(data<{ staff: { id: string; name: string } }>(unlocked).staff).toEqual({ id: fix.cashierId, name: "Tobi" });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await onDevice(token, "/unlock", { pin: "0000" })).status).toBe(403);
    }
    expect((await onDevice(token, "/unlock", { pin: "4821" })).status).toBe(429);
  });

  it("sells from a draft store on an open shift, once per idempotency key, attributed to the cashier", async () => {
    const fix = await tillFixture("Sale Owner");
    const token = await pairDevice(fix);

    const catalog = data<{ products: { id: string; variants: { priceMinor: string | null }[] }[] }>(await onDevice(token, "/catalog"));
    expect(catalog.products.map((product) => product.id)).toEqual([fix.productId]);
    expect(catalog.products[0]!.variants[0]!.priceMinor).toBe("250000");
    expect((await onDevice(token, `/products/${fix.productId}`)).status).toBe(200);
    expect(data<{ groups: unknown[] }>(await onDevice(token, `/products/${fix.productId}/modifier-groups`)).groups).toEqual([]);

    const sale = { items: [{ product_id: fix.productId, quantity: 2 }], payment_method: "cash", staff_id: fix.cashierId, idempotency_key: randomUUID() };
    expect((await onDevice(token, "/order", sale)).status).toBe(409);

    expect((await onDevice(token, "/shift/open", { opening_cash_minor: 500000, staff_id: fix.cashierId })).status).toBe(201);
    const first = await onDevice(token, "/order", sale);
    expect(first.status).toBe(200);
    const again = await onDevice(token, "/order", sale);
    const orderId = data<{ order: { order_id: string; total_minor: number } }>(first).order.order_id;
    expect(data<{ order: { order_id: string } }>(again).order.order_id).toBe(orderId);
    expect(data<{ order: { total_minor: number } }>(first).order.total_minor).toBe(500000);

    const order = data<{ order: { operatorStaffId: string; posDeviceId: string; createdBy: string | null } }>(
      await request(server.baseUrl, `/api/businesses/${fix.businessId}/orders/${orderId}`, { cookie: fix.cookies }),
    ).order;
    expect(order.operatorStaffId).toBe(fix.cashierId);
    expect(order.posDeviceId).toBeTruthy();
    expect(order.createdBy).toBeNull();
    expect((await request(server.baseUrl, `/api/businesses/${fix.businessId}/orders/${orderId}/receipt`, { cookie: fix.cookies })).status).toBe(200);

    const listed = data<{ orders: { id: string; operatorName: string }[] }>(await onDevice(token, "/orders"));
    expect(listed.orders).toEqual([expect.objectContaining({ id: orderId, operatorName: "Tobi" })]);

    const summary = data<{ summary: { cashSalesMinor: string; expectedCashMinor: string } }>(await onDevice(token, "/shift/summary")).summary;
    expect(summary).toMatchObject({ cashSalesMinor: "500000", expectedCashMinor: "1000000" });
    const closed = await onDevice(token, "/shift/close", { counted_cash_minor: 1000000, staff_id: fix.cashierId });
    expect(data<{ shift: { varianceMinor: string; closedByStaffId: string } }>(closed).shift).toMatchObject({ varianceMinor: "0", closedByStaffId: fix.cashierId });
  });

  it("refuses people without till access and anything from another business", async () => {
    const fix = await tillFixture("Guard Owner");
    const token = await pairDevice(fix);
    const partyId = (await post<{ party: { id: string } }>(fix, "/parties", { kind: "person", displayName: "No Till" })).json.party.id;
    const bookableOnly = (await post<{ staff: { id: string } }>(fix, "/staff", { partyId, displayName: "Nora" })).json.staff.id;
    expect((await onDevice(token, "/shift/open", { opening_cash_minor: 0, staff_id: bookableOnly })).status).toBe(403);
    expect((await onDevice(token, "/shift/open", { opening_cash_minor: 0, staff_id: fix.cashierId })).status).toBe(201);

    const other = await tillFixture("Other Owner");
    const foreignSale = { items: [{ product_id: other.productId, quantity: 1 }], payment_method: "card", staff_id: fix.cashierId, idempotency_key: randomUUID() };
    const foreign = await onDevice(token, "/order", foreignSale);
    expect(foreign.status).toBe(404);
    expect((await onDevice(token, `/products/${other.productId}/modifier-groups`)).status).toBe(404);

    // The owner's own dashboard access is unchanged by device permissions.
    const outsider = await owner("Outsider");
    const denied = await request(server.baseUrl, `/api/businesses/${fix.businessId}/stores/${fix.storeId}/registers/${fix.registerId}/pairing-code`, { method: "POST", cookie: outsider.cookies, body: "{}" });
    expect(denied.status).toBe(403);
  });
});
