import { randomUUID } from "node:crypto";

const verificationMessages: { to: string; code: string }[] = [];
jest.mock("@/shared/email.js", () => ({
  emailSender: { sendVerificationCode: (to: string, code: string) => verificationMessages.push({ to, code }), sendPasswordResetEmail: () => {} },
}));

// Controllable payment-provider fake: `mock`-prefixed so Jest's hoisted mock
// factory may close over it. Flip mockTransferOutcome per test to exercise the
// success and provider-failure paths without any Brails/Anchor configuration.
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

async function createBusiness(cookies: string): Promise<{ businessId: string; base: string }> {
  const response = await request(server.baseUrl, "/api/businesses", { method: "POST", cookie: cookies, body: JSON.stringify({ displayName: `Transfers Co ${randomUUID().slice(0, 8)}` }) });
  const business = (response.body as { data: { business: { id: string } } }).data.business;
  return { businessId: business.id, base: `/api/businesses/${business.id}/transfers` };
}

interface Beneficiary {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly accountNumber: string;
}
interface Transfer {
  readonly id: string;
  readonly status: string;
  readonly reference: string;
  readonly failureReason: string | null;
  readonly journalEntryId: string | null;
  readonly attempts: { status: string; provider: string; providerTransferCode: string | null; failureReason: string | null }[];
}

async function addBeneficiary(cookies: string, base: string, overrides: Partial<{ accountNumber: string; kind: string }> = {}): Promise<Beneficiary> {
  const response = await request(server.baseUrl, `${base}/beneficiaries`, {
    method: "POST",
    cookie: cookies,
    body: JSON.stringify({ kind: overrides.kind ?? "supplier", bankCode: "058", accountNumber: overrides.accountNumber ?? "0123456789", accountName: "Jane Supplier" }),
  });
  return (response.body as { data: { beneficiary: Beneficiary } }).data.beneficiary;
}

describe("transfers domain", () => {
  it("requires authentication", async () => {
    expect((await request(server.baseUrl, `/api/businesses/${randomUUID()}/transfers/beneficiaries`)).status).toBe(401);
  });

  it("creates, dedupes, lists, fetches, and archives beneficiaries", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);

    const created = await addBeneficiary(cookies, base);
    expect(created.status).toBe("active");
    expect(created.kind).toBe("supplier");

    // Same bank coordinates return the same beneficiary, not a duplicate.
    const again = await addBeneficiary(cookies, base);
    expect(again.id).toBe(created.id);

    const list = (await request(server.baseUrl, `${base}/beneficiaries`, { cookie: cookies })).body as { data: { beneficiaries: Beneficiary[] } };
    expect(list.data.beneficiaries).toHaveLength(1);

    const fetched = (await request(server.baseUrl, `${base}/beneficiaries/${created.id}`, { cookie: cookies })).body as { data: { beneficiary: Beneficiary } };
    expect(fetched.data.beneficiary.id).toBe(created.id);

    const archived = (await request(server.baseUrl, `${base}/beneficiaries/${created.id}`, { method: "DELETE", cookie: cookies })).body as { data: { beneficiary: Beneficiary } };
    expect(archived.data.beneficiary.status).toBe("archived");
  });

  it("executes a transfer through the provider and records the attempt", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const beneficiary = await addBeneficiary(cookies, base);

    const response = await request(server.baseUrl, base, {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ beneficiaryId: beneficiary.id, amountMinor: "500000", purpose: "supplier_payment", idempotencyKey: `idem-${randomUUID()}` }),
    });
    expect(response.status).toBe(201);
    const transfer = (response.body as { data: { transfer: Transfer } }).data.transfer;
    expect(transfer.status).toBe("success");
    expect(transfer.attempts).toHaveLength(1);
    expect(transfer.attempts[0]!.provider).toBe("brails");
    expect(transfer.attempts[0]!.providerTransferCode).toBe("trf_test");
    // Journal posting is the caller's responsibility in this slice.
    expect(transfer.journalEntryId).toBeNull();
  });

  it("dedupes a retried transfer by idempotency key", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const beneficiary = await addBeneficiary(cookies, base);
    const idempotencyKey = `idem-${randomUUID()}`;
    const body = JSON.stringify({ beneficiaryId: beneficiary.id, amountMinor: "250000", purpose: "general", idempotencyKey });

    const first = (await request(server.baseUrl, base, { method: "POST", cookie: cookies, body })).body as { data: { transfer: Transfer } };
    const second = (await request(server.baseUrl, base, { method: "POST", cookie: cookies, body })).body as { data: { transfer: Transfer } };
    expect(second.data.transfer.id).toBe(first.data.transfer.id);

    const list = (await request(server.baseUrl, base, { cookie: cookies })).body as { data: { transfers: Transfer[] } };
    expect(list.data.transfers).toHaveLength(1);
  });

  it("captures a provider failure as a failed transfer, not a 500", async () => {
    mockTransferOutcome = "throw";
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const beneficiary = await addBeneficiary(cookies, base);

    const response = await request(server.baseUrl, base, {
      method: "POST",
      cookie: cookies,
      body: JSON.stringify({ beneficiaryId: beneficiary.id, amountMinor: "1000", purpose: "general", idempotencyKey: `idem-${randomUUID()}` }),
    });
    expect(response.status).toBe(201);
    const transfer = (response.body as { data: { transfer: Transfer } }).data.transfer;
    expect(transfer.status).toBe("failed");
    expect(transfer.attempts[0]!.status).toBe("failed");
    expect(transfer.failureReason).toBeTruthy();
  });

  it("rejects a zero amount and an unknown beneficiary", async () => {
    const { cookies } = await authenticate("Owner");
    const { base } = await createBusiness(cookies);
    const beneficiary = await addBeneficiary(cookies, base);

    const zero = await request(server.baseUrl, base, { method: "POST", cookie: cookies, body: JSON.stringify({ beneficiaryId: beneficiary.id, amountMinor: "0", purpose: "general", idempotencyKey: `idem-${randomUUID()}` }) });
    expect(zero.status).toBe(400);

    const unknown = await request(server.baseUrl, base, { method: "POST", cookie: cookies, body: JSON.stringify({ beneficiaryId: randomUUID(), amountMinor: "1000", purpose: "general", idempotencyKey: `idem-${randomUUID()}` }) });
    expect(unknown.status).toBe(404);
  });

  it("denies access to another tenant's transfers (RLS + permission)", async () => {
    const owner = await authenticate("OwnerA");
    const { base, businessId } = await createBusiness(owner.cookies);
    const beneficiary = await addBeneficiary(owner.cookies, base);

    const outsider = await authenticate("OutsiderB");
    const readOther = await request(server.baseUrl, `${base}/beneficiaries/${beneficiary.id}`, { cookie: outsider.cookies });
    expect(readOther.status).toBe(403);

    const transferOther = await request(server.baseUrl, `/api/businesses/${businessId}/transfers`, {
      method: "POST",
      cookie: outsider.cookies,
      body: JSON.stringify({ beneficiaryId: beneficiary.id, amountMinor: "1000", purpose: "general", idempotencyKey: `idem-${randomUUID()}` }),
    });
    expect(transferOther.status).toBe(403);
  });
});
