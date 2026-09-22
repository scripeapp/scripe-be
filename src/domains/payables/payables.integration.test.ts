import { randomUUID } from "node:crypto";
let verificationMessages: { to: string; code: string }[];
jest.mock("@/shared/email.js", () => ({ emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} } }));
import { request, startTestServer, type TestServer } from "@/test-support/http.js";
const PASSWORD = "Sup3rSecret!pass";
let server: TestServer;
beforeAll(async () => { verificationMessages = []; server = await startTestServer(); });
afterAll(async () => server.close());
async function cookie(): Promise<string> { const email = `payables-${randomUUID()}@example.com`; const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Payables", password: PASSWORD }) }); const body = signup.body as { user?: { id: string }; data?: { user?: { id: string } } }; const code = verificationMessages.find(m => m.to === email)?.code; if (signup.status !== 200 || !(body.user?.id ?? body.data?.user?.id) || !code) throw new Error("Unable to authenticate payables actor"); const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) }); return verified.cookies; }
describe("payables domain", () => {
  it("requires authentication", async () => { expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/payables/bills`)).status).toBe(401); });
  it("rejects invalid bill contracts", async () => { const c = await cookie(); const b = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: c, body: JSON.stringify({ displayName: "Payables Market" }) }); const id = (b.body as { data: { business: { id: string } } }).data.business.id; const response = await request(server.baseUrl, `/api/businesses/${id}/payables/bills`, { method: "POST", cookie: c, body: JSON.stringify({ billNumber: "", totalMinor: -1, lines: [] }) }); expect(response.status).toBe(400); });
});
