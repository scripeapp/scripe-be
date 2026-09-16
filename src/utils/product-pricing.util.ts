import { resolvePaymentAmount } from "./currency-rates.util";
import { SUPPORTED_CURRENCIES } from "./payment/types";
import type { SupportedCurrency } from "./payment/types";

/** A price a seller set explicitly for one currency. */
export interface CurrencyPrice {
  price: number;
  compare_at_price: number | null;
}

/**
 * Explicit per-currency prices for a product, keyed by ISO currency code.
 * Currencies absent from the map fall back to live FX conversion of the NGN base.
 */
export type CurrencyPriceMap = Partial<Record<SupportedCurrency, CurrencyPrice>>;

/** The base currency every product is priced in. All overrides are for other currencies. */
export const BASE_CURRENCY: SupportedCurrency = "NGN";

/** Returns the seller's explicit price for a currency, or null when none is set. */
export function getCurrencyOverride(
  currencyPrices: CurrencyPriceMap | null | undefined,
  currency: SupportedCurrency,
): CurrencyPrice | null {
  if (currency === BASE_CURRENCY) return null;
  return currencyPrices?.[currency] ?? null;
}

/**
 * Resolve a product's unit price in the target currency.
 *
 * Uses the seller's explicit price when one exists for that currency; otherwise
 * falls back to FX-converting the NGN base price. This keeps overridden and
 * non-overridden currencies on the same checkout code path.
 */
export async function resolveUnitPrice(
  baseAmountNGN: number,
  currencyPrices: CurrencyPriceMap | null | undefined,
  targetCurrency: SupportedCurrency,
): Promise<number> {
  const override = getCurrencyOverride(currencyPrices, targetCurrency);
  if (override) return override.price;
  return resolvePaymentAmount(baseAmountNGN, targetCurrency);
}

/**
 * Validate a per-currency price map against the currencies a store sells in.
 * Returns an error message describing the first problem, or null when valid.
 */
export function validateCurrencyPrices(
  currencyPrices: CurrencyPriceMap | null | undefined,
  storeCurrencies: readonly string[],
): string | null {
  if (!currencyPrices) return null;

  const allowed = new Set(storeCurrencies);

  for (const [currency, price] of Object.entries(currencyPrices)) {
    if (!isSupportedCurrency(currency)) {
      return `Unsupported currency: ${currency}`;
    }
    if (currency === BASE_CURRENCY) {
      return `Set the ${BASE_CURRENCY} price on the product's base price, not in currency overrides`;
    }
    if (!allowed.has(currency)) {
      return `Store does not sell in ${currency}`;
    }
    if (!price || price.price <= 0) {
      return `Price for ${currency} must be greater than zero`;
    }
    if (
      price.compare_at_price !== null &&
      price.compare_at_price !== undefined &&
      price.compare_at_price <= price.price
    ) {
      return `Compare-at price for ${currency} must be higher than the price`;
    }
  }

  return null;
}

/**
 * Normalise the currencies a store sells in: keep only supported codes, drop
 * duplicates, and always include the NGN base as the first entry.
 */
export function normalizeSupportedCurrencies(
  input: readonly string[] | null | undefined,
): string[] {
  const valid = (input ?? []).filter(isSupportedCurrency);
  const unique = Array.from(new Set([BASE_CURRENCY, ...valid]));
  return unique;
}

function isSupportedCurrency(currency: string): currency is SupportedCurrency {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(currency);
}
