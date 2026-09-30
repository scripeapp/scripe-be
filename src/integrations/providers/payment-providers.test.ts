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

function jsonResponse(data: unknown, status = 200) {
  const jsonStr = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(jsonStr),
  };
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
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "cust_123", type: "IndividualCustomer", attributes: {} } }));
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
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "v1", type: "Verification", attributes: {} } }));
    const gateway = anchorGateway();
    const result = await gateway.validateCustomerBvn({
      customerCode: "cust_123",
      firstName: "Ada",
      lastName: "Lovelace",
      bvn: "12345678901",
      dateOfBirth: "1990-01-01",
      gender: "female",
    });
    expect(result).toEqual({ status: "pending" });
  });

  it("maps a 202-accepted account creation with no account number yet to pending", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "acc_1", type: "DepositAccount", attributes: { status: "PENDING" } } }, 202));
    const gateway = anchorGateway();
    const result = await gateway.createDedicatedAccount({ customerCode: "cust_123", email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" });
    expect(result).toMatchObject({ providerAccountId: "acc_1", accountNumber: null, status: "pending" });
  });

  it("maps an active requery with a virtual NUBAN to an active result", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      jsonResponse({
        data: { id: "acc_1", type: "DepositAccount", attributes: { status: "ACTIVE", virtualNuban: { accountNumber: "1234567890", bankName: "Providus" } } },
      }),
    );
    const gateway = anchorGateway();
    const result = await gateway.requeryDedicatedAccount({ accountNumber: null, bankSlug: null, providerAccountId: "acc_1" });
    expect(result).toMatchObject({ accountNumber: "1234567890", bankName: "Providus", status: "active" });
  });

  it("throws on a non-ok HTTP response instead of silently succeeding", async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ error: "invalid bvn" }, 422));
    const gateway = anchorGateway();
    await expect(gateway.createCustomer({ email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" })).rejects.toThrow(/couldn't accept this: .*invalid bvn/);
    // Our side's problems (bad key, our fee balance) read as unavailable, not as the merchant's fault.
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ errors: [{ detail: "Insufficient balance" }] }, 400));
    await expect(gateway.createCustomer({ email: "a@b.com", firstName: "A", lastName: "B", phone: "+2348000000000" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("resolves a bank account via the verify-account endpoint", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "v1", type: "AccountVerification", attributes: { accountName: "Ada Lovelace" } } }));
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.resolveBankAccount("0123456789", "058");

    expect(result).toEqual({ accountName: "Ada Lovelace" });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sandbox.getanchor.co/api/v1/payments/verify-account/000013/0123456789");
  });

  it("creates a counterparty with verifyName enabled", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "cp_1", type: "CounterParty", attributes: {} } }));
    global.fetch = fetchMock;

    const gateway = anchorGateway();
    const result = await gateway.createTransferRecipient({ name: "Ada Lovelace", accountNumber: "0123456789", bankCode: "058" });

    expect(result).toEqual({ recipientCode: "cp_1" });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { data: { attributes: { verifyName: boolean; bankCode: string } } };
    expect(body.data.attributes).toMatchObject({ bankCode: "000013", verifyName: true });
  });

  it("requires a source deposit account id to initiate a transfer", async () => {
    const gateway = anchorGateway();
    await expect(gateway.initiateTransfer({ amountMinor: "1000", recipientCode: "cp_1", reference: "ref1", reason: "Withdrawal" })).rejects.toThrow(/source deposit account/);
  });

  it("initiates a NIP transfer with the correct relationships and maps COMPLETED to success", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({ data: { id: "tr_1", type: "NIPTransfer", attributes: { reference: "ref1", status: "COMPLETED" } } }),
    );
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
    global.fetch = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "tr_1", type: "NIPTransfer", attributes: { reference: "ref1", status: "FAILED" } } }));
    const gateway = anchorGateway();
    const result = await gateway.finalizeTransfer({ transferCode: "tr_1", otp: "" });
    expect(result).toEqual({ transferCode: "tr_1", status: "failed", reference: "ref1" });
  });

  it("creates a business customer with every director as an officer and the primary's BVN as businessBvn", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "biz_1", type: "BusinessCustomer", attributes: {} } }));
    global.fetch = fetchMock;
    const address = { addressLine1: "1 Marina Road", city: "Lagos Island", state: "Lagos", postalCode: "101001", country: "NG" };
    const person = {
      lastName: "Okafor",
      email: "a@example.com",
      phone: "+2348031234567",
      dateOfBirth: "1988-02-01",
      nationality: "NG",
      address,
      role: "director" as const,
      ownershipPercent: 0,
      title: "Manager" as const,
      idType: "nin" as const,
      idNumber: "12345678901",
    };
    await anchorGateway().createBusinessCustomer({
      businessName: "Acme Ventures Limited",
      registrationType: "limited_liability",
      registrationNumber: "RC1234567",
      dateOfRegistration: "2019-04-12",
      industry: "Retail",
      email: "a@example.com",
      phone: "+2348031234567",
      address,
      registeredAddress: address,
      people: [
        { ...person, isPrimary: false, firstName: "Adaeze", bvn: "22222222226" },
        { ...person, isPrimary: true, firstName: "Tunde", bvn: "33333333337" },
      ],
    });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as {
      data: { attributes: { basicDetail: { businessBvn: string; registrationType: string }; officers: { fullName: { firstName: string }; phoneNumber: string }[] } };
    };
    expect(body.data.attributes.basicDetail).toMatchObject({ businessBvn: "33333333337", registrationType: "Private_Incorporated" });
    expect(body.data.attributes.officers.map((officer) => officer.fullName.firstName)).toEqual(["Adaeze", "Tunde"]);
    expect(body.data.attributes.officers[0]!.phoneNumber).toBe("08031234567");
  });

  it("opens a CURRENT deposit account for a business customer", async () => {
    const fetchMock = jest.fn().mockResolvedValue(jsonResponse({ data: { id: "acc_1", type: "DepositAccount", attributes: { status: "PENDING" } } }));
    global.fetch = fetchMock;
    await anchorGateway().createDedicatedAccount({ customerCode: "biz_1", email: "a@example.com", firstName: "A", lastName: "B", phone: "0803", accountType: "CORPORATE" });
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, { body: string }])[1].body) as {
      data: { attributes: { productName: string }; relationships: { customer: { data: { type: string } } } };
    };
    expect(body.data.attributes.productName).toBe("CURRENT");
    expect(body.data.relationships.customer.data.type).toBe("BusinessCustomer");
  });

  it("resolves unmasked AccountNumber from included relationship when deposit account is active", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: "acc_corp_1",
          type: "DepositAccount",
          attributes: {
            status: "ACTIVE",
            accountNumber: "******9800",
            accountName: "Sprout Meals Limited",
            bank: { name: "CORESTEP MICROFINANCE BANK", nipCode: "090365" },
          },
        },
        included: [
          {
            id: "num_1",
            type: "AccountNumber",
            attributes: {
              accountNumber: "2962576964",
              accountName: "Sprout Meals Limited",
              bank: { name: "PROVIDUS BANK", nipCode: "000023" },
              status: "ACTIVE",
            },
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    const result = await anchorGateway().createDedicatedAccount({
      customerCode: "biz_1",
      email: "a@example.com",
      firstName: "A",
      lastName: "B",
      phone: "0803",
      accountType: "CORPORATE",
    });

    expect(result).toMatchObject({
      providerAccountId: "acc_corp_1",
      accountNumber: "2962576964",
      bankName: "PROVIDUS BANK",
      bankSlug: "000023",
      accountName: "Sprout Meals Limited",
      status: "active",
    });
  });

  it("requeryDedicatedAccount requests ?include=AccountNumber and resolves unmasked details", async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      jsonResponse({
        data: {
          id: "acc_corp_2",
          type: "DepositAccount",
          attributes: {
            status: "ACTIVE",
            accountNumber: "******7470",
          },
        },
        included: [
          {
            id: "num_2",
            type: "AccountNumber",
            attributes: {
              accountNumber: "0123456789",
              bank: { name: "PROVIDUS BANK", nipCode: "000023" },
              accountName: "Sprout Meals",
            },
          },
        ],
      }),
    );
    global.fetch = fetchMock;
    const result = await anchorGateway().requeryDedicatedAccount({ accountNumber: null, bankSlug: null, providerAccountId: "acc_corp_2" });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/accounts/acc_corp_2?include=AccountNumber"),
      expect.anything(),
    );
    expect(result).toMatchObject({
      providerAccountId: "acc_corp_2",
      accountNumber: "0123456789",
      bankName: "PROVIDUS BANK",
      bankSlug: "000023",
      accountName: "Sprout Meals",
      status: "active",
    });
  });
});
