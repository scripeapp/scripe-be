/**
 * Webhook pending-checkout fallback tests.
 *
 * Verifies that provider payment data is merged with pending_checkouts, routed
 * through the normal fulfillment path, and marked fulfilled once an order
 * exists — and that an amount mismatch is enqueued for admin recovery instead.
 */

import {
  handleSuccessfulPayment,
  webhookController,
} from "../controllers/webhook.controller";
import { supabaseAdmin as mockedSupabaseAdmin } from "../config/supabaseAdmin";
import { createPurchaseService } from "../services/purchase.service";
import { PaymentProviderFactory } from "../utils/payment";

interface PendingRow {
  id: string;
  reference: string;
  payment_type: string;
  amount_kobo: number;
  customer_email: string;
  subaccount_code: string | null;
  metadata: Record<string, unknown>;
  status: string;
  created_at: string;
  expires_at: string;
}

const EMPTY_RESULT = { data: null, error: null };

const mockTableResults: Record<string, any> = {};
const mockChainsByTable: Record<string, any> = {};

function mockChainForTable(table: string) {
  if (mockChainsByTable[table]) return mockChainsByTable[table];
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
    maybeSingle: jest.fn(() =>
      Promise.resolve(mockTableResults[table]?.maybeSingle ?? EMPTY_RESULT),
    ),
    single: jest.fn(() =>
      Promise.resolve(mockTableResults[table]?.single ?? EMPTY_RESULT),
    ),
    then: (resolve: (v: unknown) => void) => {
      resolve(mockTableResults[table]?.result ?? EMPTY_RESULT);
      return undefined;
    },
  };
  mockChainsByTable[table] = chain;
  return chain;
}

jest.mock("../config/supabase", () => ({
  supabase: { from: jest.fn((table: string) => mockChainForTable(table)) },
}));

jest.mock("../config/supabaseAdmin", () => {
  const from = jest.fn((table: string) => mockChainForTable(table));
  return { supabaseAdmin: { from }, __esModule: true, default: { from } };
});

jest.mock("../config/plunk", () => ({
  sendEmail: jest.fn().mockResolvedValue({ emailId: "mock-email-id" }),
  trackEvent: jest.fn().mockResolvedValue({ success: true }),
  isConfigured: jest.fn().mockReturnValue(false),
  plunkClient: undefined,
}));

const mockCreatePurchaseService = jest.fn().mockReturnValue({
  saveCustomer: jest.fn().mockResolvedValue({ id: "customer-id" }),
  createOrder: jest.fn().mockResolvedValue(null),
  processTicketSales: jest.fn().mockResolvedValue([]),
  updateTicketQuantities: jest.fn().mockResolvedValue(undefined),
  getEventDetails: jest.fn().mockResolvedValue({}),
});

jest.mock("../services/purchase.service", () => ({
  createPurchaseService: jest.fn((...args: unknown[]) =>
    mockCreatePurchaseService(...args),
  ),
}));

jest.mock("../services/store.service", () => ({
  storeService: { createOrder: jest.fn().mockResolvedValue({}) },
}));

jest.mock("../services/email.service", () => ({
  emailService: {
    sendTicketReceiptEmail: jest.fn().mockResolvedValue(undefined),
    sendAuditEvent: jest.fn().mockResolvedValue(undefined),
    sendMembershipEmail: jest.fn().mockResolvedValue(undefined),
    sendTippingEmail: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../utils/tickets", () => ({
  generateQRCode: jest.fn().mockResolvedValue("data:image/png;base64,mock"),
}));

const PENDING_ROW: PendingRow = {
  id: "pending-1",
  reference: "EVT-b57ebf8a-1786991814385",
  payment_type: "event_ticket",
  amount_kobo: 103046,
  customer_email: "buyer@test.com",
  subaccount_code: "ACCT_zra6q08eg1js963",
  metadata: {
    transaction_type: "event_ticket",
    event_id: "evt-1",
    email: "buyer@test.com",
    full_name: "Buyer One",
    selectedTickets: { "ticket-1": 1 },
    tickets: [{ id: "ticket-1", ticket_name: "VIP", ticket_price: 1000 }],
  },
  status: "pending",
  created_at: "2026-08-17T10:00:00.000Z",
  expires_at: "2026-08-31T10:00:00.000Z",
};

function strippedVaPaymentData(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    reference: PENDING_ROW.reference,
    amount: 103046,
    status: "success",
    currency: "NGN",
    provider: "paystack",
    metadata: { referrer: "https://www.hilaq.com/" },
    customer: { email: "buyer@test.com", name: "Buyer One" },
    ...overrides,
  };
}

beforeEach(() => {
  Object.keys(mockTableResults).forEach((key) => delete mockTableResults[key]);
  Object.keys(mockChainsByTable).forEach((key) => delete mockChainsByTable[key]);
  jest.clearAllMocks();
});

describe("pending-checkout webhook fallback", () => {
  it("verifies Flutterwave recovery through the provider factory and restores checkout context", async () => {
    const reference = "FLW-5fc1f64c-b696-4054-8ae8-b7d0d02492a2";
    mockTableResults.pending_checkouts = {
      maybeSingle: {
        data: {
          ...PENDING_ROW,
          reference,
          metadata: {
            ...PENDING_ROW.metadata,
            currency: "GHS",
            payment_provider: "flutterwave",
          },
        },
        error: null,
      },
    };
    const verifyPayment = jest.fn().mockResolvedValue({
      reference,
      amount: 103046,
      status: "success",
      currency: "GHS",
      provider: "flutterwave",
      metadata: { provider_value: "retained" },
      customer: { email: "buyer@test.com" },
    });
    const providerSpy = jest
      .spyOn(PaymentProviderFactory, "getProviderForReference")
      .mockReturnValue({ verifyPayment } as never);

    const result = await webhookController.verifyPaymentForRecovery(reference);

    expect(providerSpy).toHaveBeenCalledWith(reference);
    expect(verifyPayment).toHaveBeenCalledWith(reference);
    expect(result.provider).toBe("flutterwave");
    expect(result.metadata).toEqual(
      expect.objectContaining({
        provider_value: "retained",
        event_id: "evt-1",
        transaction_type: "event_ticket",
      }),
    );
    providerSpy.mockRestore();
  });

  it("restores stripped metadata and fulfills the event order via the pending row", async () => {
    mockTableResults.pending_checkouts = {
      maybeSingle: { data: PENDING_ROW, error: null },
    };
    mockTableResults.profiles = { maybeSingle: EMPTY_RESULT };
    mockTableResults.orders = { maybeSingle: EMPTY_RESULT };
    mockTableResults.store_orders = {
      maybeSingle: { data: { id: "so-1" }, error: null },
    };
    mockTableResults.event_pricing_snapshots = { maybeSingle: EMPTY_RESULT };

    await handleSuccessfulPayment(strippedVaPaymentData() as never, undefined);

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    expect(createPurchaseService).toHaveBeenCalled();

    const purchaseService = mockCreatePurchaseService.mock.results[0].value;
    expect(purchaseService.createOrder).toHaveBeenCalledWith(
      "customer-id",
      "evt-1",
      103046,
      PENDING_ROW.reference,
    );
    expect(purchaseService.saveCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ email: "buyer@test.com" }),
    );

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("store_orders");
    const pendingChain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(pendingChain.update).toHaveBeenCalledWith({ status: "fulfilled" });
  });

  it("uses pending-checkout metadata for a Flutterwave payment with provider metadata", async () => {
    const reference = "FLW-5fc1f64c-b696-4054-8ae8-b7d0d02492a2";
    const flutterwavePending = {
      ...PENDING_ROW,
      reference,
      metadata: {
        ...PENDING_ROW.metadata,
        currency: "GHS",
        payment_provider: "flutterwave",
        event_payment_summary: {
          currency: "GHS",
          subtotal: 1100.46,
          discount: 70,
          surcharge: 0,
          amount: 1030.46,
          coupon_code: "SAVE70",
          coupon_applied: true,
          discounts: [
            {
              rule_id: "coupon-rule",
              mode: "flat",
              value: 70,
              amount: 70,
              coupon_code: "SAVE70",
            },
          ],
        },
      },
    };
    mockTableResults.pending_checkouts = {
      maybeSingle: { data: flutterwavePending, error: null },
    };
    mockTableResults.profiles = { maybeSingle: EMPTY_RESULT };
    mockTableResults.orders = { maybeSingle: EMPTY_RESULT };
    mockTableResults.store_orders = {
      maybeSingle: { data: { id: "so-1" }, error: null },
    };
    mockTableResults.event_pricing_snapshots = { maybeSingle: EMPTY_RESULT };

    const providerMetadata = {
      transaction_type: "event_ticket",
      event_id: "provider-event-id",
      email: "buyer@test.com",
      full_name: "Buyer One",
      selectedTickets: JSON.stringify({ "provider-ticket": 1 }),
      tickets: [{ id: "ticket-1", ticket_name: "VIP", ticket_price: 1000 }],
    };

    await handleSuccessfulPayment(
      strippedVaPaymentData({
        reference,
        currency: "GHS",
        provider: "flutterwave",
        metadata: providerMetadata,
      }) as never,
      undefined,
    );

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith("pending_checkouts");
    const purchaseService = mockCreatePurchaseService.mock.results[0].value;
    expect(purchaseService.createOrder).toHaveBeenCalledWith(
      "customer-id",
      "evt-1",
      103046,
      reference,
      {
        currency: "GHS",
        subtotal: 1100.46,
        discount: 70,
        surcharge: 0,
        discountCode: "SAVE70",
        discounts: [
          {
            rule_id: "coupon-rule",
            mode: "flat",
            value: 70,
            amount: 70,
            coupon_code: "SAVE70",
          },
        ],
      },
    );
  });

  it("blocks fulfillment on amount mismatch and enqueues the payment for recovery", async () => {
    mockTableResults.pending_checkouts = {
      maybeSingle: {
        data: { ...PENDING_ROW, amount_kobo: 100000 },
        error: null,
      },
    };

    await handleSuccessfulPayment(strippedVaPaymentData() as never, undefined);

    expect(mockedSupabaseAdmin!.from).toHaveBeenCalledWith(
      "payment_recovery_queue",
    );
    const queueChain = mockedSupabaseAdmin!.from("payment_recovery_queue");
    expect(queueChain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        payment_reference: PENDING_ROW.reference,
        paystack_amount: 103046,
      }),
      expect.objectContaining({ onConflict: "payment_reference" }),
    );

    expect(createPurchaseService).not.toHaveBeenCalled();
    const pendingChain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(pendingChain.update).not.toHaveBeenCalled();
  });

  it("falls through without fulfillment when no pending checkout exists", async () => {
    mockTableResults.pending_checkouts = { maybeSingle: EMPTY_RESULT };
    mockTableResults.profiles = { maybeSingle: EMPTY_RESULT };
    mockTableResults.orders = { maybeSingle: EMPTY_RESULT };
    mockTableResults.store_orders = { maybeSingle: EMPTY_RESULT };

    await handleSuccessfulPayment(strippedVaPaymentData() as never, undefined);

    expect(createPurchaseService).not.toHaveBeenCalled();
    const pendingChain = mockedSupabaseAdmin!.from("pending_checkouts");
    expect(pendingChain.update).not.toHaveBeenCalled();
  });
});
