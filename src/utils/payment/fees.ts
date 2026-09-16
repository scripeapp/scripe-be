/**
 * Shared payment fee policy: platform-fee percentages, the Flutterwave
 * gateway schedule, and checkout gross-up helpers. Initiation and
 * verification must both derive from here so they can never drift.
 *
 * FLW rates are the highest published local rate per currency (the buyer
 * picks the method after we quote). Source: flutterwave.com/<cc>/pricing,
 * August 2026. No per-transaction caps are published anymore. NGN bakes in
 * the 7.5% VAT FLW states applies to Nigerian fees; unlisted taxes elsewhere
 * are a known unknown — fee true-up logging will surface them per currency.
 */

import type { SupportedCurrency } from "./types";
import type { FeeBearer } from "../../types/payment";

export type { SupportedCurrency };

/** Buyer currency treated as domestic; every other currency is international. */
const DOMESTIC_CURRENCY = "NGN";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PLATFORM_FEE_PERCENT_DOMESTIC = envNumber(
  "PLATFORM_FEE_PERCENT_DOMESTIC",
  0.015,
);
export const PLATFORM_FEE_PERCENT_INTERNATIONAL = envNumber(
  "PLATFORM_FEE_PERCENT_INTERNATIONAL",
  0.02,
);

export const FLW_GATEWAY_RATE: Record<SupportedCurrency, number> = {
  NGN: 0.0215,
  GHS: 0.026,
  KES: 0.032,
  ZAR: 0.029,
  TZS: 0.048,
  UGX: 0.048,
  XAF: 0.048,
  XOF: 0.048,
  RWF: 0.048,
  ZMW: 0.03,
  USD: 0.048,
  GBP: 0.048,
};

export function getPlatformFeePercent(currency: string): number {
  return currency.toUpperCase() === DOMESTIC_CURRENCY
    ? PLATFORM_FEE_PERCENT_DOMESTIC
    : PLATFORM_FEE_PERCENT_INTERNATIONAL;
}

export type PaymentProviderId = "paystack" | "flutterwave";

/**
 * Which gateway processes a charge: Paystack for domestic NGN, Flutterwave
 * for everything else. A recorded provider from checkout metadata wins so
 * legacy/in-flight records keep verifying under their original maths.
 */
export function resolvePaymentProvider(
  currency: string,
  recordedProvider?: string | null,
): PaymentProviderId {
  if (recordedProvider === "flutterwave") return "flutterwave";
  return currency.toUpperCase() === DOMESTIC_CURRENCY
    ? "paystack"
    : "flutterwave";
}

export function isFlutterwaveSupportedCurrency(code: string): boolean {
  return code.toUpperCase() in FLW_GATEWAY_RATE;
}

function roundUpToMinorUnit(value: number): number {
  return Math.ceil(value * 100) / 100;
}

export function calculateFlutterwaveGatewayFee(
  itemsTotal: number,
  currency: SupportedCurrency,
): number {
  return roundUpToMinorUnit(itemsTotal * FLW_GATEWAY_RATE[currency]);
}

/**
 * Flat credit Flutterwave routes to a merchant subaccount. Unlike Paystack,
 * FLW distributes `charge − real fee`, so the merchant's fee share must be
 * baked in here — sending the raw base would over-split and settle negative.
 */
export function deriveFlutterwaveMerchantShare(params: {
  feeBearer: FeeBearer;
  baseAmount: number;
  totalToCharge: number;
  platformFee: number;
  gatewayFee: number;
}): number {
  const roundMinor = (value: number): number => Number(value.toFixed(2));
  const { feeBearer, baseAmount, totalToCharge, platformFee, gatewayFee } =
    params;

  if (feeBearer === "customer") {
    return roundMinor(baseAmount);
  }
  if (feeBearer === "subaccount") {
    return roundMinor(totalToCharge - platformFee - gatewayFee);
  }
  return roundMinor(baseAmount - (platformFee + gatewayFee) / 2);
}

/**
 * Flat credit for commission-model flows (tips, courses): no gross-up, the
 * merchant keeps a fixed percent and Hilaq's remainder absorbs fees. Warns
 * when that remainder can go negative for the currency.
 */
export function deriveFlutterwaveCommissionShare(params: {
  chargeAmount: number;
  /** Whole-number percent the merchant keeps, e.g. 90 for a 10% Hilaq cut. */
  merchantPercent: number;
  currency: SupportedCurrency;
}): number {
  const { chargeAmount, merchantPercent, currency } = params;
  const worstCaseFeePercent =
    FLW_GATEWAY_RATE[currency] + getPlatformFeePercent(currency);
  if (merchantPercent / 100 <= worstCaseFeePercent) {
    console.warn(
      `[fees] merchant percent ${merchantPercent}% cannot cover worst-case ` +
        `${(worstCaseFeePercent * 100).toFixed(2)}% fees for ${currency} — ` +
        "Hilaq may settle negative on split transactions.",
    );
  }
  return Number((chargeAmount * (merchantPercent / 100)).toFixed(2));
}

function roundToMinorUnit(value: number): number {
  return Number(value.toFixed(2));
}

/**
 * Paystack NGN quote: gross up so the customer covers Paystack's fee
 * ((base + P + flat) / (1 - rate)), honouring the flat-fee waiver and cap.
 */
export function calculateTotalWithFees(itemsTotal: number): {
  totalToCharge: number;
  platformFee: number;
  paystackFee: number;
} {
  const PLATFORM_FEE_PERCENT = 1.5;
  const PAYSTACK_RATE = 0.015;
  const PAYSTACK_FLAT = 100;
  const PAYSTACK_CAP = 2000;
  const PAYSTACK_WAIVER_LIMIT = 2500;

  const platformFee = Number(
    (itemsTotal * (PLATFORM_FEE_PERCENT / 100)).toFixed(2),
  );
  const intermediateTotal = itemsTotal + platformFee;

  let totalToCharge: number;
  let paystackFee: number;

  const flatFee =
    intermediateTotal >= PAYSTACK_WAIVER_LIMIT ? PAYSTACK_FLAT : 0;

  const tentativeTotal = (intermediateTotal + flatFee) / (1 - PAYSTACK_RATE);
  const tentativeFee = tentativeTotal - intermediateTotal;

  if (tentativeFee > PAYSTACK_CAP) {
    paystackFee = PAYSTACK_CAP;
    totalToCharge = intermediateTotal + PAYSTACK_CAP;
  } else {
    totalToCharge = tentativeTotal;
    paystackFee = tentativeFee;
  }

  // Ceiling-round to nearest kobo so the customer always covers Paystack's own
  // ceiling-based fee rounding, preventing a 1-kobo shortfall to the merchant.
  return {
    totalToCharge: Math.ceil(totalToCharge * 100) / 100,
    platformFee,
    paystackFee: Math.ceil(paystackFee * 100) / 100,
  };
}

/**
 * True when the gateway-verified amount matches what we expected to charge.
 * Accepts minor units (kobo/pesewas) and allows a 1-unit tolerance so
 * ceiling rounding on either side cannot fail an honest payment. Both
 * gateways route through this — FlutterwaveProvider normalises its major
 * units to ×100 before calling.
 */
export function verifyPaymentAmount(
  verifiedAmount: number,
  expectedAmount: number,
): boolean {
  return Math.abs(verifiedAmount / 100 - expectedAmount) < 0.01;
}

export interface ChargeContext {
  provider?: PaymentProviderId;
  currency?: string;
}

export interface CustomerCharge {
  totalToCharge: number;
  platformFee: number;
  gatewayFee: number;
}

function chargeForBearer(
  fullCharge: CustomerCharge,
  itemsTotal: number,
  feeBearer: FeeBearer,
): CustomerCharge {
  if (feeBearer === "customer") {
    return fullCharge;
  }

  if (feeBearer === "subaccount") {
    return {
      totalToCharge: itemsTotal,
      platformFee: fullCharge.platformFee,
      gatewayFee: 0,
    };
  }

  const combinedFee = fullCharge.totalToCharge - itemsTotal;
  return {
    totalToCharge: roundToMinorUnit(itemsTotal + combinedFee / 2),
    platformFee: fullCharge.platformFee,
    gatewayFee: fullCharge.gatewayFee,
  };
}

function resolveFlutterwaveCharge(
  itemsTotal: number,
  feeBearer: FeeBearer,
  currency: string,
): CustomerCharge {
  const currencyKey = (isFlutterwaveSupportedCurrency(currency)
    ? currency.toUpperCase()
    : DOMESTIC_CURRENCY) as SupportedCurrency;
  const platformFee = roundToMinorUnit(
    itemsTotal * getPlatformFeePercent(currencyKey),
  );
  const intermediate = itemsTotal + platformFee;
  const gatewayFee = calculateFlutterwaveGatewayFee(intermediate, currencyKey);
  const fullCharge: CustomerCharge = {
    totalToCharge: roundToMinorUnit(intermediate + gatewayFee),
    platformFee,
    gatewayFee,
  };
  return chargeForBearer(fullCharge, itemsTotal, feeBearer);
}

/**
 * Single source of truth for what the customer pays per fee-bearer mode.
 * Checkout and verification must both call this so they cannot drift.
 */
export function resolveCustomerCharge(
  itemsTotal: number,
  feeBearer: FeeBearer,
  context: ChargeContext = {},
): CustomerCharge {
  if (context.provider === "flutterwave") {
    return resolveFlutterwaveCharge(
      itemsTotal,
      feeBearer,
      context.currency ?? DOMESTIC_CURRENCY,
    );
  }

  const fullFees = calculateTotalWithFees(itemsTotal);
  const fullCharge: CustomerCharge = {
    totalToCharge: fullFees.totalToCharge,
    platformFee: fullFees.platformFee,
    gatewayFee: fullFees.paystackFee,
  };
  return chargeForBearer(fullCharge, itemsTotal, feeBearer);
}

export interface VaDepositFees {
  paystackFee: number;
  hilaqFee: number;
  totalFee: number;
}

export const KOBOS_PER_NAIRA = 100;
const VA_DEPOSIT_FEE_PAYSTACK_PERCENT = 1;
const VA_DEPOSIT_FEE_HILAQ_PERCENT = 1;
const VA_DEPOSIT_FEE_PAYSTACK_CAP_NAIRA = 300;
const VA_DEPOSIT_FEE_TOTAL_CAP_NAIRA = 500;

const vaDepositPaystackFeeCapKobo =
  VA_DEPOSIT_FEE_PAYSTACK_CAP_NAIRA * KOBOS_PER_NAIRA;
const vaDepositTotalFeeCapKobo =
  VA_DEPOSIT_FEE_TOTAL_CAP_NAIRA * KOBOS_PER_NAIRA;

const percentInKobo = (amountKobo: number, percent: number) =>
  Math.round((amountKobo * percent) / 100);

/**
 * Compute VA-deposit fees from the Paystack amount (integer kobo) so the
 * arithmetic stays exact. Hilaq's cut is total minus Paystack's; the shared
 * total cap (₦500) always covers Paystack's cap (₦300), so the remainder is
 * never negative.
 */
export function calculateVaDepositFees(grossKobo: number): VaDepositFees {
  const paystackFeeKobo = Math.min(
    percentInKobo(grossKobo, VA_DEPOSIT_FEE_PAYSTACK_PERCENT),
    vaDepositPaystackFeeCapKobo,
  );
  const totalFeeKobo = Math.min(
    percentInKobo(grossKobo, VA_DEPOSIT_FEE_PAYSTACK_PERCENT + VA_DEPOSIT_FEE_HILAQ_PERCENT),
    vaDepositTotalFeeCapKobo,
  );
  const hilaqFeeKobo = totalFeeKobo - paystackFeeKobo;

  return {
    paystackFee: paystackFeeKobo / KOBOS_PER_NAIRA,
    hilaqFee: hilaqFeeKobo / KOBOS_PER_NAIRA,
    totalFee: totalFeeKobo / KOBOS_PER_NAIRA,
  };
}