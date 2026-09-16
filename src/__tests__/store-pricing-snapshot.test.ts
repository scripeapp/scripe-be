const FAKE_RATE = 0.002;
const RATE_TIMESTAMP = "2026-08-21T10:00:00.000Z";

jest.mock("../utils/currency-rates.util", () => ({
  resolvePaymentAmount: jest.fn(
    async (amount: number, currency: string) =>
      currency === "NGN"
        ? amount
        : Number((amount * FAKE_RATE).toFixed(2)),
  ),
  resolvePaymentConversion: jest.fn(
    async (amount: number, currency: string) => ({
      amount:
        currency === "NGN"
          ? amount
          : Number((amount * FAKE_RATE).toFixed(2)),
      rate: currency === "NGN" ? 1 : FAKE_RATE,
      source: currency === "NGN" ? "base_currency" : "flutterwave",
      rateTimestamp: RATE_TIMESTAMP,
    }),
  ),
}));

import { StoreService } from "../services/store.service";

describe("store checkout pricing snapshot", () => {
  const service = new StoreService({} as never);

  it("records explicit prices separately from exact FX-converted prices", async () => {
    const snapshot = await (service as any).buildCheckoutPricingSnapshot({
      items: [
        {
          product_id: "explicit-product",
          product_name: "Explicit GHS product",
          variant_id: null,
          variant_name: null,
          variant_price_adjustment: 0,
          quantity: 1,
          price: 5_000,
          slot: null,
          selected_modifiers: [],
          note: null,
        },
        {
          product_id: "fx-product",
          product_name: "FX product",
          variant_id: "variant-1",
          variant_name: "Large",
          variant_price_adjustment: 500,
          quantity: 2,
          price: 2_500,
          slot: null,
          selected_modifiers: [],
          note: null,
        },
      ],
      products: [
        {
          id: "explicit-product",
          price: 5_000,
          currency_prices: {
            GHS: { price: 12, compare_at_price: null },
          },
        },
        { id: "fx-product", price: 2_000, currency_prices: {} },
      ],
      subtotalNGN: 10_000,
      discountNGN: 1_000,
      deliveryFeeNGN: 500,
      taxAmountNGN: 250,
      serviceChargeAmountNGN: 100,
      targetCurrency: "GHS",
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.currency).toBe("GHS");
    expect(snapshot.items[0]).toEqual(
      expect.objectContaining({
        pricing_source: "explicit_currency_price",
        converted_unit_price: 12,
        base_price_fx: undefined,
      }),
    );
    expect(snapshot.items[1]).toEqual(
      expect.objectContaining({
        pricing_source: "fx_conversion",
        converted_unit_price: 5,
        converted_variant_adjustment: 1,
        base_price_fx: expect.objectContaining({
          rate: FAKE_RATE,
          rate_timestamp: RATE_TIMESTAMP,
          source: "flutterwave",
        }),
        variant_fx: expect.objectContaining({ rate: FAKE_RATE }),
      }),
    );
    expect(snapshot.subtotal).toBe(22);
    expect(snapshot.discount).toBe(2.2);
    expect(snapshot.delivery).toEqual(
      expect.objectContaining({
        original_amount_ngn: 500,
        converted_amount: 1,
        fx: expect.objectContaining({ rate: FAKE_RATE }),
      }),
    );
    expect(snapshot.pre_provider_fee_total).toBe(21.5);
  });
});
