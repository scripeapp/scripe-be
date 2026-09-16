/**
 * Shared derivation of event-order discount accounting from authoritative
 * checkout evidence (`event_pricing_snapshots` + submitted coupon codes).
 *
 * Used by both the webhook (reconstructing a payment summary when Paystack
 * stripped or predates `event_payment_summary`) and the backfill script
 * (repairing historical orders), so both always agree.
 */

import type { EventPaymentSummary } from "../types/webhook";

export interface CouponRule {
  id: string;
  code: string;
  mode: "flat" | "percent";
  value: number;
  message?: string;
}

export interface DiscountDetail {
  rule_id: string;
  mode: "flat" | "percent";
  value: number;
  amount: number;
  coupon_code?: string;
  message?: string;
}

export interface PricingSnapshotEvidence {
  reference: string;
  breakdown?: unknown;
  base_total?: number | null;
  adjustment_total?: number | null;
  currency?: string | null;
}

export interface DerivedDiscountEvidence {
  subtotalAmount: number | null;
  discountAmount: number;
  surchargeAmount: number;
  breakdownCodes: string[];
  discountedSeats: Array<{ basePrice: number; absAdjustment: number }>;
}

const ROUNDING_TOLERANCE = 0.05;

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function normaliseCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normaliseCurrency(value: unknown): string {
  const code = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[A-Z]{3}$/.test(code) ? code : "NGN";
}

export function extractSubmittedCoupon(
  metadata: unknown,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;

  const summary = record.event_payment_summary;
  if (summary && typeof summary === "object") {
    const coupon = (summary as Record<string, unknown>).coupon_code;
    if (typeof coupon === "string" && coupon.trim()) return coupon.trim();
  }
  const flat = record.coupon_code;
  if (typeof flat === "string" && flat.trim()) return flat.trim();
  return null;
}

export function extractCouponRules(pricingRules: unknown): CouponRule[] {
  if (!Array.isArray(pricingRules)) return [];
  const rules: CouponRule[] = [];
  for (const rule of pricingRules) {
    if (!rule || typeof rule !== "object") continue;
    const record = rule as Record<string, unknown>;
    if (record.active !== true) continue;
    const condition = record.condition as Record<string, unknown> | undefined;
    const adjustment = record.adjustment as Record<string, unknown> | undefined;
    if (!condition || condition.type !== "coupon_code") continue;
    const code = typeof condition.code === "string" ? condition.code.trim() : "";
    if (!code) continue;
    rules.push({
      id: typeof record.id === "string" ? record.id : "",
      code,
      mode: adjustment?.mode === "percent" ? "percent" : "flat",
      value: Number(adjustment?.amount) || 0,
      ...(typeof record.message === "string" && record.message
        ? { message: record.message }
        : {}),
    });
  }
  return rules;
}

/**
 * Reduce a pricing snapshot to accounting totals plus seat-level evidence for
 * coupon attribution. Falls back to net `adjustment_total` when the snapshot
 * predates per-seat breakdowns.
 */
export function deriveDiscountEvidence(
  snapshot: PricingSnapshotEvidence,
): DerivedDiscountEvidence {
  const seats: Array<Record<string, unknown>> = Array.isArray(
    snapshot.breakdown,
  )
    ? (snapshot.breakdown as Array<Record<string, unknown>>)
    : [];

  let discountTotal = 0;
  let surchargeTotal = 0;
  const breakdownCodes = new Set<string>();
  const discountedSeats: Array<{
    basePrice: number;
    absAdjustment: number;
  }> = [];

  for (const seat of seats) {
    const adjustment = Number(seat?.adjustment);
    if (!Number.isFinite(adjustment)) continue;
    if (adjustment < 0) {
      discountTotal += Math.abs(adjustment);
      discountedSeats.push({
        basePrice: Number(seat?.basePrice) || 0,
        absAdjustment: Math.abs(adjustment),
      });
    } else if (adjustment > 0) {
      surchargeTotal += adjustment;
    }

    const appliedDiscounts = Array.isArray(seat?.appliedDiscounts)
      ? (seat.appliedDiscounts as Array<Record<string, unknown>>)
      : [];
    for (const discount of appliedDiscounts) {
      const code = discount?.couponCode ?? discount?.coupon_code;
      if (typeof code === "string" && code.trim()) {
        breakdownCodes.add(code.trim());
      }
    }
  }

  if (seats.length === 0) {
    const netAdjustment = Number(snapshot.adjustment_total) || 0;
    if (netAdjustment < 0) discountTotal = Math.abs(netAdjustment);
    else if (netAdjustment > 0) surchargeTotal = netAdjustment;
  }

  return {
    subtotalAmount:
      snapshot.base_total != null &&
      Number.isFinite(Number(snapshot.base_total))
        ? round2(Number(snapshot.base_total))
        : null,
    discountAmount: round2(discountTotal),
    surchargeAmount: round2(surchargeTotal),
    breakdownCodes: Array.from(breakdownCodes).sort(),
    discountedSeats,
  };
}

function matchesRule(
  rule: CouponRule,
  derived: DerivedDiscountEvidence,
): boolean {
  if (derived.discountedSeats.length === 0) return false;
  const expected = derived.discountedSeats.reduce((total, seat) => {
    return (
      total +
      (rule.mode === "percent"
        ? (seat.basePrice * rule.value) / 100
        : rule.value)
    );
  }, 0);
  return Math.abs(round2(expected) - derived.discountAmount) <= ROUNDING_TOLERANCE;
}

/**
 * Attribute the observed discount to a coupon rule. Priority:
 * 1. Codes recorded in the snapshot breakdown (newest pricing engine).
 * 2. Code submitted at checkout, matched against active rules case-insensitively.
 * 3. Sole-candidate fallback whose expected math reproduces the discount.
 */
export function resolveAttribution(
  derived: DerivedDiscountEvidence,
  submittedCode: string | null,
  couponRules: CouponRule[],
): { code: string | null; rule: CouponRule | null } {
  if (derived.discountAmount <= 0) return { code: null, rule: null };

  if (derived.breakdownCodes.length > 0) {
    const first = couponRules.find(
      (rule) =>
        normaliseCode(rule.code) === normaliseCode(derived.breakdownCodes[0]),
    );
    return { code: derived.breakdownCodes.join(","), rule: first ?? null };
  }

  const submitted = normaliseCode(submittedCode);
  if (submitted) {
    const matched = couponRules.find(
      (rule) => normaliseCode(rule.code) === submitted,
    );
    if (matched) return { code: matched.code, rule: matched };
    return { code: submittedCode, rule: null };
  }

  if (couponRules.length === 1 && matchesRule(couponRules[0], derived)) {
    return { code: couponRules[0].code, rule: couponRules[0] };
  }

  return { code: null, rule: null };
}

/** Column-shaped payload for orders-table updates. */
export function buildOrderAccountingPatch(
  snapshot: PricingSnapshotEvidence,
  derived: DerivedDiscountEvidence,
  attribution: { code: string | null; rule: CouponRule | null },
): {
  subtotal_amount: number | null;
  discount_amount: number;
  surcharge_amount: number;
  currency: string;
  discount_code: string | null;
  discount_details: DiscountDetail[];
} {
  const hasDiscount = derived.discountAmount > 0;
  return {
    subtotal_amount: derived.subtotalAmount,
    discount_amount: derived.discountAmount,
    surcharge_amount: derived.surchargeAmount,
    currency: normaliseCurrency(snapshot.currency),
    discount_code: hasDiscount ? attribution.code : null,
    discount_details:
      hasDiscount && attribution.rule
        ? [
            {
              rule_id: attribution.rule.id,
              mode: attribution.rule.mode,
              value: attribution.rule.value,
              amount: derived.discountAmount,
              ...(attribution.rule.code
                ? { coupon_code: attribution.rule.code }
                : {}),
              ...(attribution.rule.message
                ? { message: attribution.rule.message }
                : {}),
            },
          ]
        : [],
  };
}

/**
 * Rebuild an EventPaymentSummary from checkout evidence when the provider
 * metadata did not carry one. Returns undefined when there is no pricing
 * snapshot to derive from.
 */
export function deriveEventPaymentSummary(params: {
  snapshot: PricingSnapshotEvidence;
  couponRules: CouponRule[];
  submittedCode: string | null;
  verifiedAmount?: number;
}): EventPaymentSummary | undefined {
  const derived = deriveDiscountEvidence(params.snapshot);
  const hasAnyPricing =
    derived.subtotalAmount !== null ||
    derived.discountAmount > 0 ||
    derived.surchargeAmount > 0;
  if (!hasAnyPricing) return undefined;

  const attribution = resolveAttribution(
    derived,
    params.submittedCode,
    params.couponRules,
  );

  return {
    currency: normaliseCurrency(params.snapshot.currency),
    subtotal: derived.subtotalAmount ?? 0,
    discount: derived.discountAmount,
    surcharge: derived.surchargeAmount,
    amount:
      params.verifiedAmount ??
      round2(derived.subtotalAmount ?? 0) -
        derived.discountAmount +
        derived.surchargeAmount,
    coupon_code: attribution.code,
    coupon_applied: !!attribution.code,
    discounts:
      derived.discountAmount > 0 && attribution.rule
        ? [
            {
              rule_id: attribution.rule.id,
              mode: attribution.rule.mode,
              value: attribution.rule.value,
              amount: derived.discountAmount,
              ...(attribution.rule.code
                ? { coupon_code: attribution.rule.code }
                : {}),
              ...(attribution.rule.message
                ? { message: attribution.rule.message }
                : {}),
            },
          ]
        : undefined,
  };
}
