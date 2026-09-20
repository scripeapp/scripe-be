import { randomUUID } from "node:crypto";
const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());
async function authenticate(label: string) { const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`; const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) }); const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } }; const code = verificationMessages.find((message) => message.to === email)?.code; const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) }); return { userId: body.user?.id ?? body.data?.user?.id, cookies: verified.cookies }; }
describe("carts and orders domains", () => {
  it("requires authentication", async () => expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/carts`)).status).toBe(401));
  it("creates a cart, snapshots its priced line into an order, and is idempotent", async () => {
    const owner = await authenticate("Commerce Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "Commerce Test Co" }) });
    const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const base = `/api/businesses/${business.id}`;
    const channelResponse = await request(server.baseUrl, `${base}/stores/${business.defaultStore.id}/channels`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ code: `web${randomUUID().slice(0, 6)}`, name: "Web", kind: "storefront" }) });
    if (channelResponse.status !== 201) throw new Error(`channel ${channelResponse.status}: ${JSON.stringify(channelResponse.body)}`);
    const channel = (channelResponse.body as { data: { channel: { id: string } } }).data.channel;
    const productResponse = await request(server.baseUrl, `${base}/products`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Test Widget", status: "active", variant: { name: "Default" } }) });
    const variant = (productResponse.body as { data: { product: { variants: [{ id: string }] } } }).data.product.variants[0];
    await request(server.baseUrl, `${base}/prices`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ productVariantId: variant.id, assetCode: "NGN", amountMinor: 125000 }) });
    const cartResponse = await request(server.baseUrl, `${base}/carts`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ storeId: business.defaultStore.id, channelId: channel.id }) });
    const cart = (cartResponse.body as { data: { cart: { id: string } } }).data.cart;
    await request(server.baseUrl, `${base}/carts/${cart.id}/lines`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ productVariantId: variant.id, quantity: 2 }) });
    const idempotencyKey = `checkout-${randomUUID()}`;
    const first = await request(server.baseUrl, `${base}/carts/${cart.id}/checkout`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ idempotencyKey }) });
    expect(first.status).toBe(201);
    const orderId = (first.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId;
    const retry = await request(server.baseUrl, `${base}/carts/${cart.id}/checkout`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ idempotencyKey }) });
    expect((retry.body as { data: { checkout: { orderId: string } } }).data.checkout.orderId).toBe(orderId);
    const order = await request(server.baseUrl, `${base}/orders/${orderId}`, { cookie: owner.cookies });
    expect(order.status).toBe(200);
    const orderData = (order.body as { data: { order: { totalMinor: string; lines: unknown[] } } }).data.order;
    expect(orderData.totalMinor).toBe("250000");
    expect(Array.isArray(orderData.lines)).toBe(true);
  });
});
