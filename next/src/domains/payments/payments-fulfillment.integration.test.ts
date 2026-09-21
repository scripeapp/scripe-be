import { randomUUID } from "node:crypto";
let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
let server: TestServer;
beforeAll(async () => { verificationMessages = []; server = await startTestServer(); }); afterAll(async () => server.close());
describe("payments and fulfillment domains", () => {
  it("require authentication", async () => {
    const businessId = randomUUID();
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/payments`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/fulfillment`)).status).toBe(401);
  });
  it("reject malformed payment and fulfillment contracts", async () => {
    const email = `payment-${randomUUID()}@example.com`;
    const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Payments", password: "Sup3rSecret!pass" }) });
    const code = verificationMessages.find((m) => m.to === email)?.code;
    expect(signup.status).toBe(200); expect(code).toBeDefined();
    const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
    const business = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: verified.cookies, body: JSON.stringify({ displayName: "Payments Market" }) });
    const id = (business.body as { data: { business: { id: string } } }).data.business.id;
    expect((await request(server.baseUrl, `/api/businesses/${id}/payments`, { method: "POST", cookie: verified.cookies, body: JSON.stringify({ orderId: "bad" }) })).status).toBe(400);
    expect((await request(server.baseUrl, `/api/businesses/${id}/fulfillment`, { method: "POST", cookie: verified.cookies, body: JSON.stringify({ orderId: "bad" }) })).status).toBe(400);
  });

  it("requires authentication for checkout endpoints", async () => {
    const businessId = randomUUID();
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/payments/checkout`, { method: "POST" })).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/payments/checkout/ref1/verify`, { method: "POST" })).status).toBe(401);
  });

  it("rejects a malformed checkout contract and an unknown gateway name", async () => {
    const email = `checkout-${randomUUID()}@example.com`;
    await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Checkout", password: "Sup3rSecret!pass" }) });
    const code = verificationMessages.find((m) => m.to === email)?.code;
    const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
    const business = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: verified.cookies, body: JSON.stringify({ displayName: "Checkout Market" }) });
    const id = (business.body as { data: { business: { id: string } } }).data.business.id;

    expect((await request(server.baseUrl, `/api/businesses/${id}/payments/checkout`, { method: "POST", cookie: verified.cookies, body: JSON.stringify({ orderId: "bad" }) })).status).toBe(400);
    expect(
      (
        await request(server.baseUrl, `/api/businesses/${id}/payments/checkout`, {
          method: "POST",
          cookie: verified.cookies,
          body: JSON.stringify({ orderId: randomUUID(), gateway: "stripe", assetCode: "NGN", amountMinor: 500000, email, idempotencyKey: `co-${randomUUID()}` }),
        })
      ).status,
    ).toBe(400);
  });

  it("fails checkout initiation cleanly when neither gateway is configured", async () => {
    const email = `checkout-unconfigured-${randomUUID()}@example.com`;
    await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Checkout", password: "Sup3rSecret!pass" }) });
    const code = verificationMessages.find((m) => m.to === email)?.code;
    const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
    const business = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: verified.cookies, body: JSON.stringify({ displayName: "Unconfigured Checkout Co" }) });
    const id = (business.body as { data: { business: { id: string } } }).data.business.id;

    const response = await request(server.baseUrl, `/api/businesses/${id}/payments/checkout`, {
      method: "POST",
      cookie: verified.cookies,
      body: JSON.stringify({ orderId: randomUUID(), gateway: "paystack", assetCode: "NGN", amountMinor: 500000, email, idempotencyKey: `co-${randomUUID()}` }),
    });
    expect(response.status).toBe(503);
  });

  it("returns not found when verifying a checkout reference that was never initiated", async () => {
    const email = `checkout-verify-${randomUUID()}@example.com`;
    await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Checkout", password: "Sup3rSecret!pass" }) });
    const code = verificationMessages.find((m) => m.to === email)?.code;
    const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
    const business = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: verified.cookies, body: JSON.stringify({ displayName: "Verify Checkout Co" }) });
    const id = (business.body as { data: { business: { id: string } } }).data.business.id;

    const response = await request(server.baseUrl, `/api/businesses/${id}/payments/checkout/never-initiated/verify`, { method: "POST", cookie: verified.cookies });
    expect(response.status).toBe(404);
  });
});
