import { randomUUID } from "node:crypto";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());

describe("approvals domain", () => {
  it("requires authentication on workflow and decision routes", async () => {
    const businessId = randomUUID();
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approval-workflows`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approvals`)).status).toBe(401);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/approvals/${randomUUID()}/approve`, { method: "POST" })).status).toBe(401);
  });
});
