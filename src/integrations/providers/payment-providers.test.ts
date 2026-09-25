/**
 * These gateways issue real HTTP requests against Brails/Anchor, so this
 * suite mocks `fetch` and verifies request shaping + response mapping
 * offline — the same approach r2.test.ts uses for presigned URLs, since
 * neither needs a live Postgres or a live provider to exercise correctly.
 */
import type { PaymentProviderGateway } from "../payment-provider.js";
import { BrailsPaymentProviderGateway } from "./brails-payment-provider.js";
import { AnchorPaymentProviderGateway } from "./anchor-payment-provider.js";

function brailsGateway(): PaymentProviderGateway {
  return new BrailsPaymentProviderGateway();
}

function anchorGateway(): PaymentProviderGateway {
  return new AnchorPaymentProviderGateway();
}

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://scripe_app@localhost:5432/scripe_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("BrailsPaymentProviderGateway", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, BRAILS_API_KEY: "test-brails-key", BRAILS_BASE_URL: "https://sandboxapi.onbrails.com/api/v1" };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when BRAILS_API_KEY is missing", async () => {
    process.env = { ...MINIMAL_ENV };
    const gateway = brailsGateway();
    await expect(gateway.createDedicatedAccount({ customerCode: "c1", email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000", bvn: "12345678901" })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("rejects account creation without a BVN", async () => {
    const gateway = brailsGateway();
    await expect(gateway.createDedicatedAccount({ customerCode: "c1", email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" })).rejects.toThrow(/BVN/);
  });

  it("sends the correct request shape and maps an active account", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          status: true,
          message: "ok",
          data: { id: "va_123", accountNumber: "1234567890", accountName: "Ada Lovelace", bankName: "safehaven", status: "active" },
        }),
    });
    global.fetch = fetchMock;

    const gateway = brailsGateway();
    const result = await gateway.createDedicatedAccount({ customerCode: "c1", email: "a@b.com", firstName: "Ada", lastName: "Lovelace", phone: "+2348000000000", bvn: "12345678901", preferredBank: "providus" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandboxapi.onbrails.com/api/v1/virtual-accounts");
    expect(options.method).toBe("POST");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer test-brails-key");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ bvn: "12345678901", bank: "providus", firstName: "Ada", lastName: "Lovelace" });

    expect(result).toMatchObject({ providerAccountId: "va_123", accountNumber: "1234567890", status: "active" });
  });

  it("maps a needs_verification account to pending status", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, message: "ok", data: { id: "va_456", status: "needs_verification" } }),
    });

    const gateway = brailsGateway();
    const result = await gateway.createDedicatedAccount({ customerCode: "c1", email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000", bvn: "12345678901" });
    expect(result.status).toBe("pending");
  });

  it("requires a provider account id to requery", async () => {
    const gateway = brailsGateway();
    await expect(gateway.requeryDedicatedAccount({ accountNumber: null, bankSlug: null, providerAccountId: null })).rejects.toThrow(/provider id/);
  });

  it("resolves a bank account via the v2 beneficiaries lookup endpoint", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, message: "ok", data: { accountName: "Ada Lovelace" } }),
    });
    global.fetch = fetchMock;

    const gateway = brailsGateway();
    const result = await gateway.resolveBankAccount("0123456789", "058");

    expect(result).toEqual({ accountName: "Ada Lovelace" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandboxapi.onbrails.com/api/v2/beneficiaries/lookup");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ country: "NG", accountNumber: "0123456789", bankCode: "058" });
  });

  it("requires the sender's registered address to create a payout beneficiary", async () => {
    const gateway = brailsGateway();
    await expect(gateway.createTransferRecipient({ name: "n", accountNumber: "1234567890", bankCode: "058" })).rejects.toThrow(/registered address/);
  });

  it("creates a payout beneficiary with the sender's compliance details when the address is supplied", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: true, message: "ok", data: { id: "ben_1" } }) });
    global.fetch = fetchMock;

    const gateway = brailsGateway();
    const result = await gateway.createTransferRecipient({
      name: "Ada Lovelace",
      accountNumber: "1234567890",
      bankCode: "058",
      sender: { businessName: "Ada Co", addressLine1: "1 Main St", city: "Lagos", country: "Nigeria", postalCode: "100001" },
    });

    expect(result).toEqual({ recipientCode: "ben_1" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandboxapi.onbrails.com/api/v2/beneficiaries");
    const body = JSON.parse(options.body as string) as { destination: { sender: { accountName: string; city: string } } };
    expect(body.destination.sender).toMatchObject({ accountName: "Ada Co", city: "Lagos" });
  });

  it("requires the customer's KYC email to initiate a payout", async () => {
    const gateway = brailsGateway();
    await expect(gateway.initiateTransfer({ amountMinor: "1000", recipientCode: "ben_1", reference: "ref", reason: "x" })).rejects.toThrow(/KYC email/);
  });

  it("initiates a payout and maps a successful status", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: true, message: "ok", data: { id: "payout_1", reference: "brails-ref-1", status: "SUCCESSFUL" } }) });
    global.fetch = fetchMock;

    const gateway = brailsGateway();
    const result = await gateway.initiateTransfer({ amountMinor: "1000", recipientCode: "ben_1", reference: "ref", reason: "Withdrawal", customerEmail: "owner@example.com" });

    expect(result).toEqual({ transferCode: "payout_1", status: "success", reference: "brails-ref-1" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://sandboxapi.onbrails.com/api/v2/wallets/payout/initialize");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ amount: 1000, customerEmail: "owner@example.com", beneficiaryId: "ben_1" });
  });

  it("finalizeTransfer re-checks a payout's status via the finalize endpoint and maps a failure", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: true, message: "ok", data: { id: "payout_1", reference: "brails-ref-1", status: "FAILED" } }) });
    const gateway = brailsGateway();
    const result = await gateway.finalizeTransfer({ transferCode: "payout_1", otp: "" });
    expect(result).toEqual({ transferCode: "payout_1", status: "failed", reference: "brails-ref-1" });
  });
});

describe("AnchorPaymentProviderGateway", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, ANCHOR_API_KEY: "test-anchor-key", ANCHOR_BASE_URL: "https://api.sandbox.getanchor.co/api/v1" };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when ANCHOR_API_KEY is missing", async () => {
    process.env = { ...MINIMAL_ENV };
    const gateway = anchorGateway();
    await expect(gateway.createCustomer({ email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("creates a customer with the x-anchor-key header and JSON:API body", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "cust_123", type: "IndividualCustomer", attributes: {} } }),
    });
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.createCustomer({ email: "a@b.com", firstName: "Ada", lastName: "Lovelace", phone: "+2348000000000" });

    expect(result).toEqual({ customerCode: "cust_123" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sandbox.getanchor.co/api/v1/customers");
    expect((options.headers as Record<string, string>)["x-anchor-key"]).toBe("test-anchor-key");
    const body = JSON.parse(options.body as string) as { data: { type: string; attributes: { fullName: { firstName: string } } } };
    expect(body.data.type).toBe("IndividualCustomer");
    expect(body.data.attributes.fullName.firstName).toBe("Ada");
  });

  it("always reports pending status for BVN validation, since Anchor confirms it asynchronously", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: "v1", type: "Verification", attributes: {} } }) });
    const gateway = anchorGateway();
    const result = await gateway.validateCustomerBvn({
      customerCode: "cust_123",
      firstName: "Ada",
      lastName: "Lovelace",
      bvn: "12345678901",
      bankCode: "058",
      accountNumber: "0123456789",
      dateOfBirth: "1990-01-01",
      gender: "female",
    });
    expect(result).toEqual({ status: "pending" });
  });

  it("maps a 202-accepted account creation with no account number yet to pending", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: "acc_1", type: "DepositAccount", attributes: { status: "PENDING" } } }) });
    const gateway = anchorGateway();
    const result = await gateway.createDedicatedAccount({ customerCode: "cust_123", email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" });
    expect(result).toMatchObject({ providerAccountId: "acc_1", accountNumber: null, status: "pending" });
  });

  it("maps an active requery with a virtual NUBAN to an active result", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: { id: "acc_1", type: "DepositAccount", attributes: { status: "ACTIVE", virtualNuban: { accountNumber: "1234567890", bankName: "Providus" } } },
        }),
    });
    const gateway = anchorGateway();
    const result = await gateway.requeryDedicatedAccount({ accountNumber: null, bankSlug: null, providerAccountId: "acc_1" });
    expect(result).toMatchObject({ accountNumber: "1234567890", bankName: "Providus", status: "active" });
  });

  it("throws on a non-ok HTTP response instead of silently succeeding", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve('{"error":"invalid bvn"}') });
    const gateway = anchorGateway();
    await expect(gateway.createCustomer({ email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" })).rejects.toThrow(/Anchor API error/);
  });

  it("resolves a bank account via the verify-account endpoint", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: "v1", type: "AccountVerification", attributes: { accountName: "Ada Lovelace" } } }) });
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.resolveBankAccount("0123456789", "058");

    expect(result).toEqual({ accountName: "Ada Lovelace" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sandbox.getanchor.co/api/v1/payments/verify-account/058/0123456789");
  });

  it("creates a counterparty with verifyName enabled", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: "cp_1", type: "CounterParty", attributes: {} } }) });
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.createTransferRecipient({ name: "Ada Lovelace", accountNumber: "0123456789", bankCode: "058" });

    expect(result).toEqual({ recipientCode: "cp_1" });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { data: { attributes: { verifyName: boolean; bankCode: string } } };
    expect(body.data.attributes).toMatchObject({ bankCode: "058", verifyName: true });
  });

  it("requires a source deposit account id to initiate a transfer", async () => {
    const gateway = anchorGateway();
    await expect(gateway.initiateTransfer({ amountMinor: "1000", recipientCode: "cp_1", reference: "ref1", reason: "Withdrawal" })).rejects.toThrow(/source deposit account/);
  });

  it("initiates a NIP transfer with the correct relationships and maps COMPLETED to success", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: { id: "tr_1", type: "NIPTransfer", attributes: { reference: "ref1", status: "COMPLETED" } } }),
    });
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.initiateTransfer({ amountMinor: "1000", recipientCode: "cp_1", reference: "ref1", reason: "Withdrawal", sourceAccountId: "acc_1" });

    expect(result).toEqual({ transferCode: "tr_1", status: "success", reference: "ref1" });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { data: { relationships: { account: { data: { id: string } } }; attributes: { amount: number } } };
    expect(body.data.relationships.account.data.id).toBe("acc_1");
    expect(body.data.attributes.amount).toBe(1000);
  });

  it("finalizeTransfer re-checks status without needing an OTP, since Anchor has no OTP step", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ data: { id: "tr_1", type: "NIPTransfer", attributes: { reference: "ref1", status: "FAILED" } } }) });
    const gateway = anchorGateway();
    const result = await gateway.finalizeTransfer({ transferCode: "tr_1", otp: "" });
    expect(result).toEqual({ transferCode: "tr_1", status: "failed", reference: "ref1" });
  });
});
