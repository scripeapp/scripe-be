/**
 * Provider pending-checkout persistence tests.
 *
 * Verifies every payment initiation path (hosted checkout and per-order
 * virtual-account bank transfer) persists a pending_checkouts row keyed by the
 * reference returned by the provider — without failing the initiate when the
 * persist fails.
 */

import { PaystackProvider } from "../utils/payment/PaystackProvider";
import { FlutterwaveProvider } from "../utils/payment/FlutterwaveProvider";
import { supabaseAdmin as mockedSupabaseAdmin } from "../config/supabaseAdmin";
import pendingCheckoutService from "../services/pending-checkout.service";

const EMPTY_RESULT = { data: null, error: null };

const mockChainByTable: Record<string, any> = {};

function mockChain(table: string) {
  if (mockChainByTable[table]) return mockChainByTable[table];
  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    range: jest.fn(() => chain),
    maybeSingle: jest.fn(() => Promise.resolve(EMPTY_RESULT)),
    then: (resolve: (v: unknown) => void) => {
      resolve(EMPTY_RESULT);
      return undefined;
    },
  };
  mockChainByTable[table] = chain;
  return chain;
}

jest.mock("../config/supabaseAdmin", () => {
  const from = jest.fn((table: string) => mockChain(table));
  return { supabaseAdmin: { from }, __esModule: true, default: { from } };
});

jest.mock("axios", () => ({
  post: jest.fn().mockResolvedValue({
    data: {
      status: "success",
      message: "",
      data: { link: "https://checkout.flutterwave.com/xyz" },
    },
  }),
  get: jest.fn().mockResolvedValue({ data: { status: false } }),
  isAxiosError: jest.fn(() => false),
}));

jest.mock("../utils/paystack.util", () => ({
  initializePaystackPayment: jest
    .fn()
    .mockResolvedValue({
      authorization_url: "https://checkout.paystack.com/abc",
      reference: "EVT-b57ebf8a-1786991814385",
    }),
  initializePaystackBankTransfer: jest.fn().mockResolvedValue({
    reference: "EVT-b57ebf8a-1786991814385",
    virtualAccount: {
      bankName: "Wema Bank",
      accountName: "HILAQ",
      accountNumber: "1234567890",
      expiresAt: "2026-08-17T11:00:00.000Z",
    },
  }),
  verifyPaystackPayment: jest.fn(),
  calculateTotalWithFees: jest.fn((amount: number) => ({
    totalToCharge: amount,
    platformFee: 0,
    paystackFee: 0,
  })),
}));

beforeEach(() => {
  Object.keys(mockChainByTable).forEach((key) => delete mockChainByTable[key]);
  jest.clearAllMocks();
});

describe("PaystackProvider pending-checkout persistence", () => {
  it("preserves raw Paystack recovery details during normalization", async () => {
    const { verifyPaystackPayment } = jest.requireMock(
      "../utils/paystack.util",
    );
    const raw = {
      reference: "PSK-1",
      amount: 10000,
      status: "success",
      metadata: { transaction_type: "store_purchase" },
      customer: {
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
        phone: null,
      },
      currency: "NGN",
      paid_at: "2026-08-21T10:00:00.000Z",
      channel: "dedicated_nuban",
      subaccount: { id: 123, subaccount_code: "ACCT_merchant" },
    };
    verifyPaystackPayment.mockResolvedValueOnce(raw);

    const result = await new PaystackProvider().verifyPayment("PSK-1");

    expect(result.channel).toBe("dedicated_nuban");
    expect(result.subaccountCode).toBe("ACCT_merchant");
    expect(result.raw).toBe(raw);
  });

  it("persists a pending checkout after hosted payment initialization", async () => {
    const provider = new PaystackProvider();
    const pricingSnapshot = {
      version: 1,
      currency: "NGN",
      items: [],
    } as any;

    await provider.initializePayment({
      amount: 1030.46,
      email: "buyer@test.com",
      currency: "NGN",
      metadata: {
        transaction_type: "event_ticket",
        event_id: "evt-1",
        pricing_snapshot: pricingSnapshot,
      },
      subaccountCode: "ACCT_zra6q08eg1js963",
    });

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    const chain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "EVT-b57ebf8a-1786991814385",
        payment_type: "event_ticket",
        amount_kobo: 103046,
        customer_email: "buyer@test.com",
        subaccount_code: "ACCT_zra6q08eg1js963",
        metadata: expect.objectContaining({
          event_id: "evt-1",
          pricing_snapshot: pricingSnapshot,
        }),
      }),
    );
    const { initializePaystackPayment } = jest.requireMock(
      "../utils/paystack.util",
    );
    expect(initializePaystackPayment.mock.calls[0][3]).not.toHaveProperty(
      "pricing_snapshot",
    );
  });

  it("persists a pending checkout after bank-transfer initialization", async () => {
    const provider = new PaystackProvider();

    await provider.initiateBankTransfer({
      amount: 1030.46,
      email: "buyer@test.com",
      metadata: { transaction_type: "event_ticket" },
      subaccountCode: "ACCT_zra6q08eg1js963",
    });

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    const chain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: "EVT-b57ebf8a-1786991814385",
        payment_type: "event_ticket",
        amount_kobo: 103046,
        subaccount_code: "ACCT_zra6q08eg1js963",
      }),
    );
  });

  it("derives payment_type from the EVT- reference prefix when metadata lacks it", async () => {
    const provider = new PaystackProvider();

    await provider.initializePayment({
      amount: 1000,
      email: "buyer@test.com",
      currency: "NGN",
      metadata: { event_id: "evt-1" },
    });

    const chain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ payment_type: "event_ticket" }),
    );
  });

  it("falls back to unknown payment_type without transaction_type or a known prefix", async () => {
    const { initializePaystackPayment } = jest.requireMock("../utils/paystack.util");
    initializePaystackPayment.mockResolvedValueOnce({
      authorization_url: "https://checkout.paystack.com/abc",
      reference: "GEN-abc-123",
    });
    const provider = new PaystackProvider();

await provider.initializePayment({
      amount: 1000,
      email: "buyer@test.com",
      currency: "NGN",
      metadata: {},
    });

    const chain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({ payment_type: "unknown" }),
    );
  });

  it("does not fail the initiate when the persist fails", async () => {
    const chain = mockChain("pending_checkouts");
    chain.insert = jest.fn(() => chain);
    chain.then = (resolve: (v: unknown) => void) => {
      resolve({ data: null, error: new Error("insert failed") });
      return undefined;
    };
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const provider = new PaystackProvider();
    const result = await provider.initializePayment({
      amount: 1000,
      email: "buyer@test.com",
      currency: "NGN",
      metadata: {},
    });

    expect(result.reference).toBe("EVT-b57ebf8a-1786991814385");
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to persist checkout"),
      expect.anything(),
    );
    consoleSpy.mockRestore();
  });
});

describe("FlutterwaveProvider pending-checkout persistence", () => {
  beforeEach(() => {
    process.env.FLW_SECRET_KEY = "test-secret-key";
  });

  it("persists a pending checkout after payment initialization", async () => {
    const provider = new FlutterwaveProvider();
    const pricingSnapshot = {
      version: 1,
      currency: "GHS",
      items: [],
    } as any;

    await provider.initializePayment({
      amount: 500,
      email: "buyer@test.com",
      currency: "GHS",
      metadata: {
        transaction_type: "store_purchase",
        store_id: "store-1",
        flw_subaccount_id: "RS_merchant",
        pricing_snapshot: pricingSnapshot,
      },
    });

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    const chain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(chain.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_type: "store_purchase",
        amount_kobo: 50000,
        customer_email: "buyer@test.com",
        metadata: expect.objectContaining({
          store_id: "store-1",
          flw_subaccount_id: "RS_merchant",
          pricing_snapshot: pricingSnapshot,
        }),
      }),
    );
    const axios = jest.requireMock("axios");
    expect(axios.post.mock.calls[0][1].meta).not.toHaveProperty(
      "pricing_snapshot",
    );
  });
});

describe("provider-independent pending-checkout lookup", () => {
  it("resolves stored checkout details by a Flutterwave transaction reference", async () => {
    const reference = "FLW-5fc1f64c-b696-4054-8ae8-b7d0d02492a2";
    const storedCheckout = {
      id: "checkout-1",
      reference,
      payment_type: "event_ticket",
      amount_kobo: 1698,
      customer_email: "buyer@test.com",
      subaccount_code: null,
      metadata: {
        transaction_type: "event_ticket",
        event_id: "event-1",
        currency: "GHS",
        payment_provider: "flutterwave",
      },
      status: "pending",
      created_at: "2026-08-21T12:00:00.000Z",
      expires_at: "2026-09-04T12:00:00.000Z",
    };
    const chain = mockChain("pending_checkouts");
    chain.maybeSingle.mockResolvedValueOnce({
      data: storedCheckout,
      error: null,
    });

    const result = await pendingCheckoutService.findByReference(
      mockedSupabaseAdmin as any,
      reference,
    );

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    expect(chain.eq).toHaveBeenCalledWith("reference", reference);
    expect(result).toEqual(storedCheckout);
    expect(result!.amount_kobo / 100).toBe(16.98);
  });
});
