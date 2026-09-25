/**
 * Mocks `fetch` and verifies request shaping + response mapping offline —
 * same approach as payment-providers.test.ts and r2.test.ts, since neither
 * gateway needs a live Postgres or a live provider to exercise correctly.
 */
import type { CheckoutGateway } from "../checkout-gateway.js";
import { PaystackCheckoutGateway } from "./paystack-checkout-gateway.js";
import { FlutterwaveCheckoutGateway } from "./flutterwave-checkout-gateway.js";

function paystackGateway(): CheckoutGateway {
  return new PaystackCheckoutGateway();
}

function flutterwaveGateway(): CheckoutGateway {
  return new FlutterwaveCheckoutGateway();
}

const MINIMAL_ENV = {
  DATABASE_URL: "postgres://scripe_app@localhost:5432/scripe_test",
  BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:4000",
};

describe("PaystackCheckoutGateway", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, PAYSTACK_SECRET_KEY: "sk_test_paystack" };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when PAYSTACK_SECRET_KEY is missing", async () => {
    process.env = { ...MINIMAL_ENV };
    const gateway = paystackGateway();
    await expect(gateway.initializeCheckout({ amountMinor: "10000", assetCode: "NGN", email: "a@b.com", reference: "ref1" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("passes amountMinor straight through as Paystack's amount, with the correct auth header", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, message: "ok", data: { authorization_url: "https://checkout.paystack.com/abc", access_code: "abc", reference: "ref1" } }),
    });
    global.fetch = fetchMock;

    const gateway = paystackGateway();
    const result = await gateway.initializeCheckout({ amountMinor: "500000", assetCode: "NGN", email: "a@b.com", reference: "ref1", callbackUrl: "https://x.test/cb" });

    expect(result).toEqual({ authorizationUrl: "https://checkout.paystack.com/abc", reference: "ref1" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.paystack.co/transaction/initialize");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_paystack");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ amount: 500000, currency: "NGN", reference: "ref1" });
  });

  it("maps a successful verification and an abandoned one to pending, not failed", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, message: "ok", data: { status: "success", amount: 500000, currency: "NGN", paid_at: "2026-01-01T00:00:00Z", gateway_response: "Approved" } }),
    });
    const success = await paystackGateway().verifyCheckout("ref1");
    expect(success).toMatchObject({ status: "success", amountMinor: "500000" });

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: true, message: "ok", data: { status: "abandoned", amount: 500000, currency: "NGN", paid_at: null, gateway_response: "" } }),
    });
    const abandoned = await paystackGateway().verifyCheckout("ref1");
    expect(abandoned.status).toBe("pending");
  });
});

describe("FlutterwaveCheckoutGateway", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env = { ...MINIMAL_ENV, FLW_SECRET_KEY: "flw_test_key" };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("throws SERVICE_UNAVAILABLE when FLW_SECRET_KEY is missing", async () => {
    process.env = { ...MINIMAL_ENV };
    const gateway = flutterwaveGateway();
    await expect(gateway.initializeCheckout({ amountMinor: "10000", assetCode: "NGN", email: "a@b.com", reference: "ref1" })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  it("converts amountMinor (kobo) to Flutterwave's major-unit amount on initialize", async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: "success", message: "ok", data: { link: "https://checkout.flutterwave.com/abc" } }) });
    global.fetch = fetchMock;

    const gateway = flutterwaveGateway();
    const result = await gateway.initializeCheckout({ amountMinor: "500000", assetCode: "NGN", email: "a@b.com", reference: "ref1" });

    expect(result).toEqual({ authorizationUrl: "https://checkout.flutterwave.com/abc", reference: "ref1" });
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.flutterwave.com/v3/payments");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer flw_test_key");
    const body = JSON.parse(options.body as string) as Record<string, unknown>;
    expect(body.amount).toBe(5000);
    expect(body.tx_ref).toBe("ref1");
  });

  it("converts Flutterwave's major-unit amount back to amountMinor (kobo) on verify", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "success", data: [{ tx_ref: "ref1", amount: 5000, currency: "NGN", status: "successful", created_at: "2026-01-01T00:00:00Z" }] }),
    });
    const result = await flutterwaveGateway().verifyCheckout("ref1");
    expect(result).toMatchObject({ status: "success", amountMinor: "500000" });
  });

  it("maps a failed transaction with a reason, and reports nothing found as pending", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "success", data: [{ tx_ref: "ref1", amount: 5000, currency: "NGN", status: "failed", created_at: "2026-01-01T00:00:00Z", processor_response: "Insufficient funds" }] }),
    });
    const failed = await flutterwaveGateway().verifyCheckout("ref1");
    expect(failed).toMatchObject({ status: "failed", failureReason: "Insufficient funds" });

    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ status: "success", data: [] }) });
    const missing = await flutterwaveGateway().verifyCheckout("ref-unknown");
    expect(missing.status).toBe("pending");
  });
});
