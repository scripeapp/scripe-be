import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

let mockTransferOutcome: "success" | "throw" = "success";
jest.mock("@/integrations/payment-provider.js", () => ({
  paymentProvider: {
    name: "brails",
    createTransferRecipient: async () => ({ recipientCode: "rcp_test" }),
    initiateTransfer: async (input: { reference: string }) => {
      if (mockTransferOutcome === "throw") throw new Error("provider unavailable");
      return { transferCode: "trf_test", status: "success", reference: input.reference };
    },
  },
}));

import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);
let server: TestServer;
beforeAll(async () => { server = await startTestServer(); });
afterAll(async () => server.close());
beforeEach(() => { mockTransferOutcome = "success"; });

async function authenticate(label: string): Promise<{ cookies: string }> {
  const email = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${randomUUID()}@example.com`;
  const signup = await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: label, password: "Sup3rSecret!pass" }) });
  if (signup.status !== 200) throw new Error(`Sign-up failed: ${JSON.stringify(signup.body)}`);
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const verified = await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) });
  return { cookies: verified.cookies };
}

interface Business { readonly businessId: string; readonly base: string; }
async function createBusiness(cookies: string): Promise<Business> {
  const response = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `Payroll Co ${randomUUID().slice(0, 8)}` }) });
  const business = (response.body as { data: { business: { id: string } } }).data.business;
  return { businessId: business.id, base: `/api/businesses/${business.id}` };
}

async function addBeneficiary(cookies: string, base: string, accountNumber: string): Promise<string> {
  const response = await request(server.baseUrl, `${base}/transfers/beneficiaries`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ kind: "employee", bankCode: "058", accountNumber, accountName: "Staff Member" }),
  });
  return (response.body as { data: { beneficiary: { id: string } } }).data.beneficiary.id;
}

interface PayrollItem { readonly status: string; readonly transferId: string | null; readonly netMinor: string; }
interface PayrollRun {
  readonly id: string;
  readonly status: string;
  readonly grossMinor: string;
  readonly deductionsMinor: string;
  readonly netMinor: string;
  readonly journalEntryId: string | null;
  readonly items: PayrollItem[];
}
function runOf(body: unknown): PayrollRun { return (body as { data: { run: PayrollRun } }).data.run; }

async function trialBalanceValue(cookies: string, base: string, code: string): Promise<{ debit: bigint; credit: bigint }> {
  const response = await request(server.baseUrl, `${base}/accounting/trial-balance`, { cookie: cookies });
  const lines = (response.body as { data: { lines: { accountCode: string; debitMinor: string; creditMinor: string }[] } }).data.lines;
  const line = lines.find((l) => l.accountCode === code);
  return { debit: BigInt(line?.debitMinor ?? "0"), credit: BigInt(line?.creditMinor ?? "0") };
}

async function createTwoPersonRun(cookies: string, base: string): Promise<PayrollRun> {
  const b1 = await addBeneficiary(cookies, base, "0000000001");
  const b2 = await addBeneficiary(cookies, base, "0000000002");
  const response = await request(server.baseUrl, `${base}/payroll/runs`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      items: [
        { beneficiaryId: b1, grossMinor: "500000", deductionsMinor: "50000" }, // net 450000
        { beneficiaryId: b2, grossMinor: "300000", deductionsMinor: "0" }, // net 300000
      ],
    }),
  });
  return runOf(response.body);
}

describe("payroll domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/payroll/runs`)).status).toBe(401);
  });

  it("creates a draft run with computed totals", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const run = await createTwoPersonRun(cookies, base);

    expect(run.status).toBe("draft");
    expect(run.grossMinor).toBe("800000");
    expect(run.deductionsMinor).toBe("50000");
    expect(run.netMinor).toBe("750000");
    expect(run.items).toHaveLength(2);
    expect(run.journalEntryId).toBeNull();
  });

  it("approves then pays a run, executing transfers and posting one balanced journal", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const created = await createTwoPersonRun(cookies, base);

    const approved = runOf((await request(server.baseUrl, `${base}/payroll/runs/${created.id}/approve`, { method: "POST", cookie: cookies })).body);
    expect(approved.status).toBe("approved");

    const paid = runOf((await request(server.baseUrl, `${base}/payroll/runs/${created.id}/pay`, { method: "POST", cookie: cookies })).body);
    expect(paid.status).toBe("paid");
    expect(paid.items.every((item) => item.status === "paid" && item.transferId)).toBe(true);
    expect(paid.journalEntryId).not.toBeNull();

    // Journal: debit payroll_expense 800000, credit bank 750000 + tax_payable 50000.
    expect((await trialBalanceValue(cookies, base, "payroll_expense")).debit).toBe(800000n);
    expect((await trialBalanceValue(cookies, base, "bank")).credit).toBe(750000n);
    expect((await trialBalanceValue(cookies, base, "tax_payable")).credit).toBe(50000n);
  });

  it("is idempotent: paying an already-paid run does not double-post or duplicate transfers", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const created = await createTwoPersonRun(cookies, base);
    await request(server.baseUrl, `${base}/payroll/runs/${created.id}/approve`, { method: "POST", cookie: cookies });

    const first = runOf((await request(server.baseUrl, `${base}/payroll/runs/${created.id}/pay`, { method: "POST", cookie: cookies })).body);
    const second = runOf((await request(server.baseUrl, `${base}/payroll/runs/${created.id}/pay`, { method: "POST", cookie: cookies })).body);
    expect(second.journalEntryId).toBe(first.journalEntryId);
    expect((await trialBalanceValue(cookies, base, "payroll_expense")).debit).toBe(800000n);

    const transfers = (await request(server.baseUrl, `${base}/transfers`, { cookie: cookies })).body as { data: { transfers: unknown[] } };
    expect(transfers.data.transfers).toHaveLength(2);
  });

  it("rejects paying a run that is not approved", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const created = await createTwoPersonRun(cookies, base);
    const response = await request(server.baseUrl, `${base}/payroll/runs/${created.id}/pay`, { method: "POST", cookie: cookies });
    expect(response.status).toBe(409);
  });

  it("validates run input", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const beneficiaryId = await addBeneficiary(cookies, base, "0000000009");
    // deductions exceed gross
    const bad = await request(server.baseUrl, `${base}/payroll/runs`, {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-09-30", items: [{ beneficiaryId, grossMinor: "1000", deductionsMinor: "2000" }] }),
    });
    expect(bad.status).toBe(400);
    // empty items
    const empty = await request(server.baseUrl, `${base}/payroll/runs`, {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-09-30", items: [] }),
    });
    expect(empty.status).toBe(400);
  });

  it("denies another tenant access to payroll", async () => {
    const owner = await authenticate("OwnerA");
    const { base, businessId } = await createBusiness(owner.cookies);
    const created = await createTwoPersonRun(owner.cookies, base);

    const outsider = await authenticate("OutsiderB");
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/payroll/runs/${created.id}`, { cookie: outsider.cookies })).status).toBe(403);
    expect((await request(server.baseUrl, `/api/businesses/${businessId}/payroll/runs`, { method: "POST", cookie: outsider.cookies, body: JSON.stringify({ periodStart: "2026-09-01", periodEnd: "2026-09-30", items: [{ beneficiaryId: randomUUID(), grossMinor: "1000", deductionsMinor: "0" }] }) })).status).toBe(403);
  });
});
