import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

let mockTransferStatus: "processing" | "success" | "throw" = "processing";
const mockTransfers: string[] = [];
jest.mock("@/integrations/payment-provider.js", () => ({
  paymentProvider: {
    name: "brails",
    createTransferRecipient: () => Promise.resolve({ recipientCode: "rcp_test" }),
    initiateTransfer: (input: { reference: string }) => {
      if (mockTransferStatus === "throw") return Promise.reject(new Error("provider unavailable"));
      mockTransfers.push(input.reference);
      return Promise.resolve({ transferCode: `trf_${input.reference}`, status: mockTransferStatus, reference: input.reference });
    },
  },
}));

import { loadEnvironment } from "@/shared/environment.js";
import { request, startTestServer, type TestServer } from "@/test-support/http.js";

jest.setTimeout(30_000);
let server: TestServer;
let migrator: Pool;
beforeAll(async () => {
  server = await startTestServer();
  const environment = loadEnvironment();
  migrator = new Pool({ connectionString: environment.DATABASE_MIGRATE_URL ?? environment.DATABASE_URL });
});
afterAll(async () => {
  await migrator.end();
  await server.close();
});
beforeEach(() => {
  mockTransferStatus = "processing";
  mockTransfers.length = 0;
});

interface Setup { readonly cookies: string; readonly businessId: string; readonly base: string; }

async function setup(walletMinor: number, kycStatus: "verified" | "pending" | "failed" | null = "verified"): Promise<Setup> {
  const email = `bill-transfers-${randomUUID()}@example.com`;
  await request(server.baseUrl, "/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email, name: "Bills Owner", password: "Sup3rSecret!pass" }) });
  const code = verificationMessages.find((message) => message.to === email)?.code;
  const cookies = (await request(server.baseUrl, "/api/auth/email-otp/verify-email", { method: "POST", body: JSON.stringify({ email, otp: code }) })).cookies;
  const created = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `Bills Co ${randomUUID().slice(0, 8)}` }) });
  const businessId = (created.body as { data: { business: { id: string } } }).data.business.id;
  if (kycStatus) await migrator.query(`insert into app.banking_profiles ("businessId", "kycStatus") values ($1, $2)`, [businessId, kycStatus]);
  if (walletMinor > 0) {
    await migrator.query(
      `insert into app.wallet_transactions ("businessId", "type", "direction", "status", "amountMinor", "provider", "providerReference", "description", "postedAt")
       values ($1, 'deposit', 'credit', 'posted', $2, 'brails', $3, 'Test deposit', now())`,
      [businessId, walletMinor, `dep_${randomUUID()}`],
    );
  }
  return { cookies, businessId, base: `/api/businesses/${businessId}` };
}

async function approvedBill(s: Setup, totalMinor: number, withBank = true): Promise<string> {
  const supplier = await request(server.baseUrl, `${s.base}/suppliers`, {
    method: "POST",
    cookie: s.cookies,
    body: JSON.stringify({
      kind: "organization",
      displayName: "Ali Bus",
      supplier: withBank ? { bankName: "GTBank", bankCode: "058", accountNumber: "0123456789", accountName: "Ali Bus Ltd" } : {},
    }),
  });
  const supplierAccountId = (supplier.body as { data: { supplier: { supplierAccount: { id: string } } } }).data.supplier.supplierAccount.id;
  const bill = await request(server.baseUrl, `${s.base}/payables/bills`, {
    method: "POST",
    cookie: s.cookies,
    body: JSON.stringify({
      supplierAccountId,
      billNumber: `INV-${randomUUID().slice(0, 6)}`,
      subtotalMinor: totalMinor,
      totalMinor,
      lines: [{ description: "Product", quantity: 1, unitAmountMinor: totalMinor, lineTotalMinor: totalMinor, accountCategory: "Inventory" }],
    }),
  });
  expect(bill.status).toBe(201);
  const billId = (bill.body as { data: { bill: { id: string } } }).data.bill.id;
  expect((await request(server.baseUrl, `${s.base}/payables/bills/${billId}/approve`, { method: "POST", cookie: s.cookies })).status).toBe(200);
  return billId;
}

async function confirmPayment(s: Setup, billId: string, body: Record<string, unknown> = {}) {
  return request(server.baseUrl, `${s.base}/payables/bills/${billId}/transfers`, {
    method: "POST",
    cookie: s.cookies,
    body: JSON.stringify({ idempotencyKey: `pay-${randomUUID()}`, ...body }),
  });
}

interface BillTransfer { status: string; amountMinor: string; approvalRequestId: string | null; pendingApproverIds: string[] }
interface BillDetail { bill: { status: string; amountPaidMinor: string }; transfers: BillTransfer[]; allocations: unknown[] }
async function bill(s: Setup, billId: string): Promise<BillDetail> {
  return ((await request(server.baseUrl, `${s.base}/payables/bills/${billId}`, { cookie: s.cookies })).body as { data: BillDetail }).data;
}

async function balance(s: Setup): Promise<string> {
  const status = await request(server.baseUrl, `${s.base}/banking/status`, { cookie: s.cookies });
  return (status.body as { data: { status: { availableBalanceMinor: string } } }).data.status.availableBalanceMinor;
}

async function decide(s: Setup, approvalRequestId: string, decision: "approve" | "reject") {
  return request(server.baseUrl, `${s.base}/approvals/${approvalRequestId}/${decision}`, { method: "POST", cookie: s.cookies });
}

async function workflowName(approvalRequestId: string | null): Promise<string | undefined> {
  const result = await migrator.query<{ workflowName: string }>(`select "workflowName" from app.approval_requests where "id" = $1`, [approvalRequestId]);
  return result.rows[0]?.workflowName;
}

async function settle(billId: string, status: "success" | "failed") {
  const withdrawal = await migrator.query<{ providerTransferCode: string }>(`select "providerTransferCode" from app.withdrawals where "billId" = $1 order by "createdAt" desc limit 1`, [billId]);
  await migrator.query(`select * from app.mark_withdrawal_status_from_webhook($1, $2, 'Account closed')`, [withdrawal.rows[0]!.providerTransferCode, status]);
}

describe("confirming payment on a bill", () => {
  it("creates a transfer that waits for approval, sends it once approved, and marks the bill paid when the bank confirms", async () => {
    const s = await setup(5_000_000);
    const billId = await approvedBill(s, 1_900_000);

    const response = await confirmPayment(s, billId);
    expect(response.status).toBe(201);
    expect((response.body as { data: unknown }).data).toMatchObject({ gated: true, transfer: { status: "awaitingApproval", amountMinor: "1900000" } });

    // Nothing has gone to the bank; the amount is held so it can't be spent twice.
    expect(mockTransfers).toHaveLength(0);
    expect(await balance(s)).toBe("3100000");
    let detail = await bill(s, billId);
    expect(detail.bill).toMatchObject({ status: "approved", amountPaidMinor: "0" });
    expect(detail.transfers[0]).toMatchObject({ status: "awaitingApproval" });
    expect((await confirmPayment(s, billId)).status).toBe(400);

    // The Bills starter workflow is switched off, but its approver (the
    // owner — also the only one, so they may approve their own) still has to.
    expect(await workflowName(detail.transfers[0]!.approvalRequestId)).toBe("Bills");
    expect((await decide(s, detail.transfers[0]!.approvalRequestId!, "approve")).status).toBe(200);
    expect(mockTransfers).toHaveLength(1);
    detail = await bill(s, billId);
    expect(detail.transfers[0]).toMatchObject({ status: "processing" });
    expect(detail.bill.status).toBe("approved");

    await settle(billId, "success");
    await settle(billId, "success"); // a redelivered webhook changes nothing
    detail = await bill(s, billId);
    expect(detail.bill).toMatchObject({ status: "paid", amountPaidMinor: "1900000" });
    expect(detail.allocations).toHaveLength(1);
    const journal = await migrator.query<{ count: number }>(`select count(*)::int as "count" from app.journal_entries where "businessId" = $1 and "description" = 'Bill paid by transfer'`, [s.businessId]);
    expect(journal.rows[0]!.count).toBe(1);
  });

  it("marks the bill paid on approval when the provider confirms on the spot", async () => {
    mockTransferStatus = "success";
    const s = await setup(5_000_000);
    const billId = await approvedBill(s, 1_000_000);
    await confirmPayment(s, billId, { amountMinor: 400_000 });
    await decide(s, (await bill(s, billId)).transfers[0]!.approvalRequestId!, "approve");
    expect((await bill(s, billId)).bill).toMatchObject({ status: "partially_paid", amountPaidMinor: "400000" });
  });

  it("returns the held money and leaves the bill owing when the transfer is rejected", async () => {
    const s = await setup(5_000_000);
    const billId = await approvedBill(s, 1_000_000);
    await confirmPayment(s, billId);
    expect((await decide(s, (await bill(s, billId)).transfers[0]!.approvalRequestId!, "reject")).status).toBe(200);

    expect(mockTransfers).toHaveLength(0);
    const detail = await bill(s, billId);
    expect(detail.transfers[0]).toMatchObject({ status: "rejected" });
    expect(detail.bill).toMatchObject({ status: "approved", amountPaidMinor: "0" });
    expect(await balance(s)).toBe("5000000");
    expect((await confirmPayment(s, billId)).status).toBe(201);
  });

  it("returns the money when the bank fails the approved transfer", async () => {
    const s = await setup(5_000_000);
    const billId = await approvedBill(s, 1_000_000);
    await confirmPayment(s, billId);
    await decide(s, (await bill(s, billId)).transfers[0]!.approvalRequestId!, "approve");
    await settle(billId, "failed");
    expect((await bill(s, billId)).bill).toMatchObject({ status: "approved", amountPaidMinor: "0" });
    expect(await balance(s)).toBe("5000000");
  });

  it("fails the transfer and returns the money when the bank errors at approval time", async () => {
    const s = await setup(5_000_000);
    const billId = await approvedBill(s, 1_000_000);
    await confirmPayment(s, billId);
    mockTransferStatus = "throw";
    await decide(s, (await bill(s, billId)).transfers[0]!.approvalRequestId!, "approve");

    const detail = await bill(s, billId);
    expect(detail.transfers[0]).toMatchObject({ status: "failed" });
    expect(detail.bill).toMatchObject({ status: "approved", amountPaidMinor: "0" });
    expect(await balance(s)).toBe("5000000");
  });

  it("falls back to the owners when the business has no Bills workflow", async () => {
    const s = await setup(5_000_000);
    const workflows = await request(server.baseUrl, `${s.base}/approval-workflows`, { cookie: s.cookies });
    const bills = (workflows.body as { data: { workflows: { id: string; type: string }[] } }).data.workflows.find((workflow) => workflow.type === "bill_payment")!;
    expect((await request(server.baseUrl, `${s.base}/approval-workflows/${bills.id}`, { method: "DELETE", cookie: s.cookies })).status).toBe(200);

    const billId = await approvedBill(s, 1_000_000);
    expect((await confirmPayment(s, billId)).status).toBe(201);
    const transfer = (await bill(s, billId)).transfers[0]!;
    expect(await workflowName(transfer.approvalRequestId)).toBe("Owner approval");
    expect(transfer.pendingApproverIds).toHaveLength(1);
    expect(mockTransfers).toHaveLength(0);
    expect((await decide(s, transfer.approvalRequestId!, "approve")).status).toBe(200);
    expect(mockTransfers).toHaveLength(1);
  });

  it("explains what's missing before creating anything", async () => {
    const noAccount = await setup(0, null);
    const noAccountResponse = await confirmPayment(noAccount, await approvedBill(noAccount, 100_000));
    expect(noAccountResponse.status).toBe(400);
    expect(JSON.stringify(noAccountResponse.body)).toContain("You haven't set up a business account yet");

    const pending = await setup(0, "pending");
    expect(JSON.stringify((await confirmPayment(pending, await approvedBill(pending, 100_000))).body)).toContain("still being verified");

    const s = await setup(500_000);
    const missing = await confirmPayment(s, await approvedBill(s, 100_000, false));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain("Add bank details for Ali Bus");

    const short = await confirmPayment(s, await approvedBill(s, 1_000_000));
    expect(short.status).toBe(400);
    expect(JSON.stringify(short.body)).toContain("Your wallet has ₦5,000.00 available");

    const created = await migrator.query<{ count: number }>(`select count(*)::int as "count" from app.withdrawals where "businessId" = any($1)`, [[noAccount.businessId, pending.businessId, s.businessId]]);
    expect(created.rows[0]!.count).toBe(0);
  });
});
