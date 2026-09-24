import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: {
    sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }),
    sendPasswordResetEmail: () => {},
    sendBankingKybSubmitted: () => {},
    sendBankingKybApproved: () => {},
    sendBankingKybFailed: () => {},
    sendVirtualAccountIssued: () => {},
    sendVirtualAccountDeposit: () => {},
  },
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

async function createBusiness(cookies: string, displayName: string): Promise<string> {
  const created = await request(server.baseUrl, "/api/businesses", {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ displayName }),
  });
  return (created.body as { data: { business: { id: string } } }).data.business.id;
}

describe("banking domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/banking/status`)).status).toBe(401);
  });

  it("reports not_started status with a zero balance before any KYC submission", async () => {
    const owner = await authenticate("Banking Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Co");

    const status = await request(server.baseUrl, `/api/businesses/${businessId}/banking/status`, { cookie: owner.cookies });
    expect(status.status).toBe(200);
    const body = (status.body as { data: { status: { kycStatus: string; virtualAccount: unknown; availableBalanceMinor: string } } }).data.status;
    expect(body.kycStatus).toBe("not_started");
    expect(body.virtualAccount).toBeNull();
    expect(body.availableBalanceMinor).toBe("0");
  });

  it("fails KYC submission cleanly when the payment provider is not configured", async () => {
    const owner = await authenticate("Banking KYC Owner");
    const businessId = await createBusiness(owner.cookies, "Banking KYC Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/kyc`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        email: "owner@example.com",
        firstName: "Ada",
        lastName: "Lovelace",
        phone: "+2348000000000",
        bvn: "12345678901",
        bankCode: "058",
        accountNumber: "0123456789",
      }),
    });
    expect(response.status).toBe(503);
    expect((response.body as { error: { code: string } }).error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("blocks a virtual account request before KYC is verified", async () => {
    const owner = await authenticate("Banking VA Owner");
    const businessId = await createBusiness(owner.cookies, "Banking VA Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/virtual-account`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(403);
  });

  it("returns not found when requerying without an existing virtual account", async () => {
    const owner = await authenticate("Banking Requery Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Requery Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/virtual-account/requery`, {
      method: "POST",
      cookie: owner.cookies,
    });
    expect(response.status).toBe(404);
  });

  it("fails bank account resolution cleanly when the payment provider is not configured", async () => {
    const owner = await authenticate("Banking Resolve Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Resolve Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/resolve-account?accountNumber=0123456789&bankCode=058`, { cookie: owner.cookies });
    expect(response.status).toBe(503);
  });

  it("blocks a withdrawal request before KYC is verified", async () => {
    const owner = await authenticate("Banking Withdrawal Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Withdrawal Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/withdrawals`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({
        amountMinor: 500000,
        bankCode: "058",
        accountNumber: "0123456789",
        accountName: "Ada Lovelace",
        idempotencyKey: `wd-${randomUUID()}`,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("returns not found when finalizing a withdrawal that was never initiated", async () => {
    const owner = await authenticate("Banking Finalize Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Finalize Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/withdrawals/finalize`, {
      method: "POST",
      cookie: owner.cookies,
      body: JSON.stringify({ transferCode: "TRF_nonexistent", otp: "123456" }),
    });
    expect(response.status).toBe(404);
  });

  it("lists an empty wallet ledger for a fresh business", async () => {
    const owner = await authenticate("Banking Ledger Owner");
    const businessId = await createBusiness(owner.cookies, "Banking Ledger Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/transactions`, { cookie: owner.cookies });
    expect(response.status).toBe(200);
    const body = response.body as { data: { transactions: unknown[]; totalCount: number } };
    expect(body.data.transactions).toEqual([]);
    expect(body.data.totalCount).toBe(0);
  });

  it("rejects cross-tenant banking access", async () => {
    const owner = await authenticate("Isolated Banking Owner");
    const outsider = await authenticate("Isolated Banking Outsider");
    const businessId = await createBusiness(owner.cookies, "Isolated Banking Co");

    const response = await request(server.baseUrl, `/api/businesses/${businessId}/banking/status`, { cookie: outsider.cookies });
    expect(response.status).toBe(403);
  });
});
