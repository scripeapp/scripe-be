import axios from "axios";
import { SUPPORTED_CURRENCIES } from "./payment/types";
import type { SupportedCurrency } from "./payment/types";

const FLW_API_URL = "https://api.flutterwave.com/v3";

const CACHE_TTL_MS = 60 * 60 * 1_000; // 1 hour

// Per-unit multiplier: rates[currency] = how many <currency> units equal 1 NGN
let rateCache: {
  rates: Record<SupportedCurrency, number>;
  expiresAt: number;
  fetchedAt: string;
} | null = null;

export interface PaymentConversion {
  amount: number;
  rate: number;
  source: "base_currency" | "flutterwave";
  rateTimestamp: string;
}

function getSecretKey(): string {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY is not configured");
  return key;
}

/**
 * Fetch NGN → all-currency per-unit multipliers using Flutterwave v3 rates API.
 *
 * Endpoint: GET /v3/transfers/rates?amount=1&source_currency=NGN&destination_currency=<X>
 * Response: { status: "success", data: { rate, source: { currency, amount }, destination: { currency, amount } } }
 *   destination.amount = how much of target currency you get for 1 NGN → our per-unit multiplier
 *
 * Results are cached in memory for 1 hour (matches frontend React Query staleTime).
 */
export async function getNGNRates(): Promise<
  Record<SupportedCurrency, number>
> {
  if (rateCache && rateCache.expiresAt > Date.now()) return rateCache.rates;

  const nonNGN = SUPPORTED_CURRENCIES.filter(
    (c) => c !== "NGN",
  ) as SupportedCurrency[];

  const results = await Promise.allSettled(
    nonNGN.map((currency) =>
      axios
        .get<{
          status: string;
          message: string;
          data: {
            rate: number;
            source: { currency: string; amount: number };
            destination: { currency: string; amount: number };
          };
        }>(
          `${FLW_API_URL}/transfers/rates`,
          {
            params: {
              amount: 1,
              source_currency: "NGN",
              destination_currency: currency,
            },
            headers: {
              Authorization: `Bearer ${getSecretKey()}`,
            },
            timeout: 10_000,
          },
        )
        .then((r) => {
          if (r.data.status !== "success") {
            throw new Error(
              `FLW rates error for NGN→${currency}: ${JSON.stringify(r.data)}`,
            );
          }
          // GET ?amount=1&source_currency=NGN → destination.amount = target units per 1 NGN
          const destAmount = r.data.data.destination.amount;
          const srcAmount = r.data.data.source.amount;
          if (!srcAmount || srcAmount <= 0 || !destAmount || destAmount <= 0) {
            throw new Error(
              `Invalid rate for NGN→${currency}: ${JSON.stringify(r.data.data)}`,
            );
          }
          const multiplier = destAmount / srcAmount;
          return { currency, rate: multiplier };
        })
        .catch((err) => {
          const body = err?.response?.data;
          if (body) {
            throw new Error(
              `FLW rates HTTP error for NGN→${currency}: ${JSON.stringify(body)}`,
            );
          }
          throw err;
        }),
    ),
  );

  const rates: Record<string, number> = { NGN: 1 };
  for (const result of results) {
    if (result.status === "fulfilled") {
      rates[result.value.currency] = result.value.rate;
    } else {
      console.error(
        "[currency-rates] Rate fetch failed:",
        result.reason?.message ?? result.reason,
      );
    }
  }

  const successCount = Object.keys(rates).length - 1;
  if (successCount === 0) {
    console.error("[currency-rates] All FLW rate fetches failed.");
  } else if (successCount < nonNGN.length) {
    console.warn(
      `[currency-rates] ${successCount}/${nonNGN.length} rates fetched.`,
    );
  }

  rateCache = {
    rates: rates as Record<SupportedCurrency, number>,
    expiresAt: Date.now() + CACHE_TTL_MS,
    fetchedAt: new Date().toISOString(),
  };
  return rateCache.rates;
}

/**
 * Convert a base NGN amount to the target currency using live FLW rates.
 * Returns the original amount unchanged when target is NGN.
 */
export async function resolvePaymentAmount(
  baseAmountNGN: number,
  targetCurrency: SupportedCurrency,
): Promise<number> {
  if (targetCurrency === "NGN") return baseAmountNGN;
  const rates = await getNGNRates();
  const rate = rates[targetCurrency];
  if (!rate || rate <= 0) {
    throw new Error(`No valid exchange rate available for ${targetCurrency}.`);
  }
  return Number((baseAmountNGN * rate).toFixed(2));
}

/** Convert an NGN amount and return the exact cached rate evidence used. */
export async function resolvePaymentConversion(
  baseAmountNGN: number,
  targetCurrency: SupportedCurrency,
): Promise<PaymentConversion> {
  if (targetCurrency === "NGN") {
    return {
      amount: baseAmountNGN,
      rate: 1,
      source: "base_currency",
      rateTimestamp: new Date().toISOString(),
    };
  }

  const rates = await getNGNRates();
  const rate = rates[targetCurrency];
  if (!rate || rate <= 0) {
    throw new Error(`No valid exchange rate available for ${targetCurrency}.`);
  }

  return {
    amount: Number((baseAmountNGN * rate).toFixed(2)),
    rate,
    source: "flutterwave",
    rateTimestamp: rateCache?.fetchedAt ?? new Date().toISOString(),
  };
}

/**
 * Convert a base NGN amount to all supported currencies.
 * Currencies with no live rate are omitted from the result.
 * Used by GET /api/utils/rates for frontend price display.
 */
export async function convertToAllCurrencies(
  baseAmountNGN: number,
): Promise<Record<SupportedCurrency, number>> {
  const rates = await getNGNRates();
  const result: Record<string, number> = {};
  for (const currency of SUPPORTED_CURRENCIES) {
    const rate = rates[currency];
    if (rate && rate > 0) {
      result[currency] = Number((baseAmountNGN * rate).toFixed(6));
    }
  }
  return result as Record<SupportedCurrency, number>;
}
