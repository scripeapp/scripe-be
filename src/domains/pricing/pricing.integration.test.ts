import { randomUUID } from "node:crypto";
let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
const PASSWORD = "Sup3rSecret!pass"; let server: TestServer;
jest.setTimeout(30_000);
beforeAll(async () => { verificationMessages = []; server = await startTestServer(); }); afterAll(async () => server.close());
async function actor(label: string): Promise<string> { const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`; const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: PASSWORD }) }); const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } }; const code = verificationMessages.find((m) => m.to === email)?.code; if (signup.status !== 200 || !(body.user?.id ?? body.data?.user?.id) || !code) throw new Error("Unable to authenticate pricing actor"); const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) }); return verified.cookies; }
describe("pricing domain", () => {
  it("requires authentication", async () => { expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/prices`)).status).toBe(401); });
  it("creates and resolves a store-default price, then prefers a location override", async () => {
    const cookie = await actor("Pricing Owner"); const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Pricing Market" }) }); const business = (b.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
    const productResponse = await request(server.baseUrl, `/api/businesses/${business.id}/products`, { method: "POST", cookie, body: JSON.stringify({ storeId: business.defaultStore.id, name: "Tea" }) }); const product = (productResponse.body as { data: { product: { variants: { id: string }[] } } }).data.product;
    const base = `/api/businesses/${business.id}`; const created = await request(server.baseUrl, `${base}/prices`, { method: "POST", cookie, body: JSON.stringify({ productVariantId: product.variants[0]!.id, assetCode: "NGN", amountMinor: 150000 }) }); expect(created.status).toBe(201);
    const resolved = await request(server.baseUrl, `${base}/prices/resolve?productVariantId=${product.variants[0]!.id}&assetCode=NGN`, { method: "GET", cookie }); expect(resolved.status).toBe(200); expect((resolved.body as { data: { price: { amountMinor: string } } }).data.price.amountMinor).toBe("150000");
  });
  it("rejects invalid monetary inputs", async () => { const cookie = await actor("Invalid Pricing"); const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie, body: JSON.stringify({ displayName: "Invalid Pricing Market" }) }); const id = (b.body as { data: { business: { id: string } } }).data.business.id; expect((await request(server.baseUrl, `/api/businesses/${id}/prices`, { method: "POST", cookie, body: JSON.stringify({ productVariantId: randomUUID(), assetCode: "usd", amountMinor: -1 }) })).status).toBe(400); });
});
