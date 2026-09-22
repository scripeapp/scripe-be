import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

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

function addressBody(overrides: Record<string, unknown> = {}) {
  return {
    recipientName: "Ada Lovelace",
    phone: "08012345678",
    addressLine1: "1 Analytical Engine Way",
    city: "Lagos",
    state: "Lagos",
    ...overrides,
  };
}

describe("addresses domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/me/addresses")).status).toBe(401);
  });

  it("creates, lists, updates, and deletes a user's own addresses", async () => {
    const user = await authenticate("Address Owner");

    const created = await request(server.baseUrl, "/api/me/addresses", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify(addressBody({ label: "Home", isDefault: true })),
    });
    expect(created.status).toBe(201);
    const address = (created.body as { data: { address: { id: string; isDefault: boolean; country: string } } }).data.address;
    expect(address.isDefault).toBe(true);
    expect(address.country).toBe("Nigeria");

    const listed = await request(server.baseUrl, "/api/me/addresses", { cookie: user.cookies });
    expect(listed.status).toBe(200);
    expect((listed.body as { data: { addresses: { id: string }[] } }).data.addresses.map((a) => a.id)).toEqual([address.id]);

    const updated = await request(server.baseUrl, `/api/me/addresses/${address.id}`, {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ city: "Abuja" }),
    });
    expect(updated.status).toBe(200);
    expect((updated.body as { data: { address: { city: string } } }).data.address.city).toBe("Abuja");

    const removed = await request(server.baseUrl, `/api/me/addresses/${address.id}`, { method: "DELETE", cookie: user.cookies });
    expect(removed.status).toBe(200);

    const afterDelete = await request(server.baseUrl, "/api/me/addresses", { cookie: user.cookies });
    expect((afterDelete.body as { data: { addresses: unknown[] } }).data.addresses).toHaveLength(0);
  });

  it("keeps exactly one default address, and promotes the oldest remaining one when the default is deleted", async () => {
    const user = await authenticate("Default Juggler");

    const first = await request(server.baseUrl, "/api/me/addresses", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify(addressBody({ label: "First", isDefault: true })),
    });
    const firstAddress = (first.body as { data: { address: { id: string } } }).data.address;

    const second = await request(server.baseUrl, "/api/me/addresses", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify(addressBody({ label: "Second", isDefault: true })),
    });
    const secondAddress = (second.body as { data: { address: { id: string; isDefault: boolean } } }).data.address;
    expect(secondAddress.isDefault).toBe(true);

    const firstAfter = await request(server.baseUrl, "/api/me/addresses", { cookie: user.cookies });
    const list = (firstAfter.body as { data: { addresses: { id: string; isDefault: boolean }[] } }).data.addresses;
    expect(list.find((a) => a.id === firstAddress.id)?.isDefault).toBe(false);
    expect(list.find((a) => a.id === secondAddress.id)?.isDefault).toBe(true);

    const removedDefault = await request(server.baseUrl, `/api/me/addresses/${secondAddress.id}`, { method: "DELETE", cookie: user.cookies });
    expect(removedDefault.status).toBe(200);

    const afterPromotion = await request(server.baseUrl, "/api/me/addresses", { cookie: user.cookies });
    const remaining = (afterPromotion.body as { data: { addresses: { id: string; isDefault: boolean }[] } }).data.addresses;
    expect(remaining).toEqual([expect.objectContaining({ id: firstAddress.id, isDefault: true })]);
  });

  it("rejects invalid address contracts", async () => {
    const user = await authenticate("Validation User");
    const response = await request(server.baseUrl, "/api/me/addresses", {
      method: "POST",
      cookie: user.cookies,
      body: JSON.stringify({ recipientName: "", phone: "", addressLine1: "", city: "", state: "" }),
    });
    expect(response.status).toBe(400);
  });

  it("isolates addresses between users", async () => {
    const owner = await authenticate("Isolated Owner");
    const outsider = await authenticate("Isolated Outsider");

    const created = await request(server.baseUrl, "/api/me/addresses", {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify(addressBody()),
    });
    const address = (created.body as { data: { address: { id: string } } }).data.address;

    const outsiderList = await request(server.baseUrl, "/api/me/addresses", { cookie: outsider.cookies });
    expect((outsiderList.body as { data: { addresses: unknown[] } }).data.addresses).toHaveLength(0);

    const outsiderUpdate = await request(server.baseUrl, `/api/me/addresses/${address.id}`, {
      method: "PATCH",
      cookie: outsider.cookies,
      body: JSON.stringify({ city: "Hijacked" }),
    });
    expect(outsiderUpdate.status).toBe(404);

    const outsiderDelete = await request(server.baseUrl, `/api/me/addresses/${address.id}`, { method: "DELETE", cookie: outsider.cookies });
    expect(outsiderDelete.status).toBe(404);
  });
});
