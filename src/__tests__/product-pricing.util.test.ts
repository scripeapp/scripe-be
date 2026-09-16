/**
 * Tests for the per-currency product pricing helpers.
 *
 * FX conversion is mocked so the tests assert the override-vs-fallback logic
 * rather than live exchange rates.
 */

// A fake rate of 0.001 target units per 1 NGN keeps the maths easy to read.
const FAKE_RATE = 0.001;

jest.mock("../utils/currency-rates.util", () => ({
  resolvePaymentAmount: jest.fn(
    async (baseAmountNGN: number, targetCurrency: string) =>
      targetCurrency === "NGN"
        ? baseAmountNGN
        : Number((baseAmountNGN * FAKE_RATE).toFixed(2)),
  ),
}));

import {
  getCurrencyOverride,
  resolveUnitPrice,
  validateCurrencyPrices,
} from "../utils/product-pricing.util";

describe("getCurrencyOverride", () => {
  it("returns the explicit price when one is set", () => {
    const prices = { USD: { price: 19.99, compare_at_price: null } };
    expect(getCurrencyOverride(prices, "USD")).toEqual({
      price: 19.99,
      compare_at_price: null,
    });
  });

  it("returns null for a currency with no override", () => {
    expect(getCurrencyOverride({ USD: { price: 5, compare_at_price: null } }, "GBP")).toBeNull();
  });

  it("never treats NGN as an override", () => {
    expect(getCurrencyOverride({ NGN: { price: 100, compare_at_price: null } } as never, "NGN")).toBeNull();
  });

  it("handles a missing price map", () => {
    expect(getCurrencyOverride(null, "USD")).toBeNull();
    expect(getCurrencyOverride(undefined, "USD")).toBeNull();
  });
});

describe("resolveUnitPrice", () => {
  it("uses the explicit override when present", async () => {
    const price = await resolveUnitPrice(
      50_000,
      { USD: { price: 30, compare_at_price: null } },
      "USD",
    );
    expect(price).toBe(30);
  });

  it("FX-converts the NGN base when no override exists", async () => {
    const price = await resolveUnitPrice(50_000, {}, "USD");
    expect(price).toBe(50); // 50_000 * 0.001
  });

  it("returns the NGN base unchanged for NGN", async () => {
    const price = await resolveUnitPrice(50_000, {}, "NGN");
    expect(price).toBe(50_000);
  });
});

describe("validateCurrencyPrices", () => {
  const storeCurrencies = ["NGN", "USD", "GBP"];

  it("accepts an empty or absent map", () => {
    expect(validateCurrencyPrices(null, storeCurrencies)).toBeNull();
    expect(validateCurrencyPrices({}, storeCurrencies)).toBeNull();
  });

  it("accepts valid overrides within the store's currencies", () => {
    const prices = {
      USD: { price: 30, compare_at_price: 40 },
      GBP: { price: 25, compare_at_price: null },
    };
    expect(validateCurrencyPrices(prices, storeCurrencies)).toBeNull();
  });

  it("rejects a currency the store does not sell in", () => {
    const prices = { KES: { price: 100, compare_at_price: null } };
    expect(validateCurrencyPrices(prices, storeCurrencies)).toMatch(/does not sell in KES/);
  });

  it("rejects an unsupported currency code", () => {
    const prices = { ABC: { price: 100, compare_at_price: null } } as never;
    expect(validateCurrencyPrices(prices, storeCurrencies)).toMatch(/Unsupported currency/);
  });

  it("rejects NGN overrides (base price only)", () => {
    const prices = { NGN: { price: 100, compare_at_price: null } } as never;
    expect(validateCurrencyPrices(prices, storeCurrencies)).toMatch(/base price/);
  });

  it("rejects a non-positive price", () => {
    const prices = { USD: { price: 0, compare_at_price: null } };
    expect(validateCurrencyPrices(prices, storeCurrencies)).toMatch(/greater than zero/);
  });

  it("rejects a compare-at price not above the price", () => {
    const prices = { USD: { price: 30, compare_at_price: 20 } };
    expect(validateCurrencyPrices(prices, storeCurrencies)).toMatch(/must be higher/);
  });
});
