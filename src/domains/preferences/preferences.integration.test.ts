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

describe("preferences domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, "/api/me/preferences")).status).toBe(401);
  });

  it("starts empty and shallow-merges patches", async () => {
    const user = await authenticate("Preferences User");

    const initial = await request(server.baseUrl, "/api/me/preferences", { cookie: user.cookies });
    expect(initial.status).toBe(200);
    expect((initial.body as { data: { preferences: Record<string, unknown> } }).data.preferences).toEqual({});

    const firstPatch = await request(server.baseUrl, "/api/me/preferences", {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ theme: "dark" }),
    });
    expect(firstPatch.status).toBe(200);
    expect((firstPatch.body as { data: { preferences: Record<string, unknown> } }).data.preferences).toEqual({ theme: "dark" });

    const secondPatch = await request(server.baseUrl, "/api/me/preferences", {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ locale: "en-NG" }),
    });
    expect(secondPatch.status).toBe(200);
    expect((secondPatch.body as { data: { preferences: Record<string, unknown> } }).data.preferences).toEqual({ theme: "dark", locale: "en-NG" });

    const overwrite = await request(server.baseUrl, "/api/me/preferences", {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({ theme: "light" }),
    });
    expect((overwrite.body as { data: { preferences: Record<string, unknown> } }).data.preferences).toEqual({ theme: "light", locale: "en-NG" });
  });

  it("rejects an empty patch", async () => {
    const user = await authenticate("Empty Patch User");
    const response = await request(server.baseUrl, "/api/me/preferences", {
      method: "PATCH",
      cookie: user.cookies,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
  });

  it("isolates preferences between users", async () => {
    const owner = await authenticate("Isolated Prefs Owner");
    const outsider = await authenticate("Isolated Prefs Outsider");

    await request(server.baseUrl, "/api/me/preferences", {
      method: "PATCH",
      cookie: owner.cookies,
      body: JSON.stringify({ secret: "owner-only" }),
    });

    const outsiderView = await request(server.baseUrl, "/api/me/preferences", { cookie: outsider.cookies });
    expect((outsiderView.body as { data: { preferences: Record<string, unknown> } }).data.preferences).toEqual({});
  });
});
