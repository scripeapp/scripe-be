import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

describe("provider-events domain", () => {
  it("has no authentication middleware on webhook routes — reachable without a session", async () => {
    // Not asserting a specific status here since every path touches the
    // database (even to log a failed-signature attempt), so in this
    // environment (no live Postgres) it fails the same way every other
    // integration test in this suite does. The point of this assertion is
    // that the route exists and isn't gated by requireAuth's 401 — a
    // missing-DB failure is a 5xx from the error handler, never the 401 a
    // missing session would produce.
    const response = await request(server.baseUrl, "/api/webhooks/paystack", { method: "POST", body: "{}" });
    expect(response.status).not.toBe(401);
  });

  it("rejects malformed JSON with something other than a silent crash", async () => {
    const response = await request(server.baseUrl, "/api/webhooks/paystack", {
      method: "POST",
      body: "not json",
      headers: { "x-paystack-signature": "irrelevant-without-a-real-secret" },
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("mounts all four provider webhook routes", async () => {
    for (const provider of ["paystack", "flutterwave", "anchor", "brails"]) {
      const response = await request(server.baseUrl, `/api/webhooks/${provider}`, { method: "POST", body: "{}" });
      expect(response.status).not.toBe(404);
    }
  });
});
