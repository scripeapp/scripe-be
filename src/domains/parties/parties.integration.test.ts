import { randomUUID } from "node:crypto";
const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());
async function actor(label: string) {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } };
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { userId: body.user?.id ?? body.data?.user?.id, cookies: verified.cookies };
}
describe("parties domain", () => {
  it("requires authentication", async () => expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/parties`)).status).toBe(401));
  it("manages a merged party with customer and supplier roles, contacts, and addresses", async () => {
    const owner = await actor("Party Owner");
    const businessResponse = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: owner.cookies, body: JSON.stringify({ displayName: "Party Test Co" }) });
    const business = (businessResponse.body as { data: { business: { id: string } } }).data.business;
    const base = `/api/businesses/${business.id}`;
    const created = await request(server.baseUrl, `${base}/parties`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Acme Trading" }) });
    expect(created.status).toBe(201);
    const party = (created.body as { data: { party: { id: string } } }).data.party;
    expect((await request(server.baseUrl, `${base}/parties/${party.id}/contacts`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "email", value: "Sales@Acme.test", isPrimary: true }) })).status).toBe(201);
    expect((await request(server.baseUrl, `${base}/parties/${party.id}/addresses`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "office", line1: "1 Marina Road", city: "Lagos", isDefault: true }) })).status).toBe(201);
    const customer = await request(server.baseUrl, `${base}/customers`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Customer Co", customer: { acquisitionChannel: "referral" } }) });
    expect(customer.status).toBe(201);
    const supplier = await request(server.baseUrl, `${base}/suppliers`, { method: "POST", cookie: owner.cookies, body: JSON.stringify({ kind: "organization", displayName: "Supplier Co", supplier: { code: "SUP-1", paymentTerms: "NET30" } }) });
    expect(supplier.status).toBe(201);
    const listed = await request(server.baseUrl, `${base}/parties`, { cookie: owner.cookies });
    expect(listed.status).toBe(200);
    expect((listed.body as { data: { parties: unknown[] } }).data.parties.length).toBe(3);
  });
});
