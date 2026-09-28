import { randomUUID } from "node:crypto";

let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
  },
}));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
jest.setTimeout(30_000);

beforeAll(async () => {
  verificationMessages = [];
  server = await startTestServer();
});
afterAll(async () => server.close());

async function authenticate(label: string): Promise<string> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ email, name: label, password: PASSWORD }),
  });
  const code = verificationMessages.find((message) => message.to === email)?.code;
  if (signup.status !== 200 || !code) throw new Error("Unable to authenticate service-settings test actor");
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", {
    method: "POST",
    body: JSON.stringify({ email, otp: code }),
  });
  return verified.cookies;
}

interface Fixture {
  cookies: string;
  businessId: string;
  storeId: string;
}

async function fixture(label: string): Promise<Fixture> {
  const cookies = await authenticate(label);
  const businessResponse = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName: `${label} Studio` }),
  });
  const business = (businessResponse.body as { data: { business: { id: string; defaultStore: { id: string } } } }).data.business;
  return { cookies, businessId: business.id, storeId: business.defaultStore.id };
}

async function createProduct(fix: Fixture, productType: "service" | "physical"): Promise<string> {
  const response = await request(server.baseUrl, `/api/businesses/${fix.businessId}/products`, {
    method: "POST",
    cookie: fix.cookies,
    body: JSON.stringify({ storeId: fix.storeId, name: "Haircut", productType }),
  });
  return (response.body as { data: { product: { id: string } } }).data.product.id;
}

function settingsUrl(fix: Fixture, productId: string): string {
  return `/api/businesses/${fix.businessId}/products/${productId}/service-settings`;
}

describe("service-settings domain", () => {
  it("requires authentication", async () => {
    const response = await request(server.baseUrl, settingsUrl({ cookies: "", businessId: randomUUID(), storeId: "" }, randomUUID()));
    expect(response.status).toBe(401);
  });

  it("saves settings for a service product, applies defaults, and reads them back", async () => {
    const fix = await fixture("Booking Owner");
    const productId = await createProduct(fix, "service");

    const saved = await request(server.baseUrl, settingsUrl(fix, productId), {
      method: "PUT",
      cookie: fix.cookies,
      body: JSON.stringify({ durationMinutes: 45, bufferAfterMinutes: 10, depositRule: { kind: "percent", percent: 20 } }),
    });
    expect(saved.status).toBe(200);
    const settings = (saved.body as { data: { serviceSettings: Record<string, unknown> } }).data.serviceSettings;
    expect(settings).toMatchObject({
      durationMinutes: 45,
      bufferAfterMinutes: 10,
      slotIntervalMinutes: 15,
      maxAdvanceDays: 60,
      locationType: "in_person",
      depositRule: { kind: "percent", percent: 20 },
    });

    const fetched = await request(server.baseUrl, settingsUrl(fix, productId), { cookie: fix.cookies });
    expect(fetched.status).toBe(200);
    expect((fetched.body as { data: { serviceSettings: { durationMinutes: number } } }).data.serviceSettings.durationMinutes).toBe(45);
  });

  it("upserts existing settings rather than duplicating", async () => {
    const fix = await fixture("Upsert Owner");
    const productId = await createProduct(fix, "service");
    await request(server.baseUrl, settingsUrl(fix, productId), { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 30 }) });
    const second = await request(server.baseUrl, settingsUrl(fix, productId), { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 60 }) });
    expect(second.status).toBe(200);
    expect((second.body as { data: { serviceSettings: { durationMinutes: number } } }).data.serviceSettings.durationMinutes).toBe(60);
  });

  it("rejects settings on a non-service product", async () => {
    const fix = await fixture("Retail Owner");
    const productId = await createProduct(fix, "physical");
    const response = await request(server.baseUrl, settingsUrl(fix, productId), { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 30 }) });
    expect(response.status).toBe(400);
  });

  it("returns 404 when settings have not been set", async () => {
    const fix = await fixture("Unset Owner");
    const productId = await createProduct(fix, "service");
    expect((await request(server.baseUrl, settingsUrl(fix, productId), { cookie: fix.cookies })).status).toBe(404);
  });

  it("rejects invalid duration", async () => {
    const fix = await fixture("Invalid Owner");
    const productId = await createProduct(fix, "service");
    const response = await request(server.baseUrl, settingsUrl(fix, productId), { method: "PUT", cookie: fix.cookies, body: JSON.stringify({ durationMinutes: 0 }) });
    expect(response.status).toBe(400);
  });
});
