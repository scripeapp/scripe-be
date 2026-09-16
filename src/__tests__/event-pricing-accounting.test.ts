import {
  buildOrderAccountingPatch,
  deriveDiscountEvidence,
  deriveEventPaymentSummary,
  extractCouponRules,
  extractSubmittedCoupon,
  resolveAttribution,
} from "../utils/event-pricing-accounting";

const mtaRule = {
  id: "rule-1",
  code: "MTA2026",
  mode: "percent" as const,
  value: 50,
  message: "MTA discount",
};

describe("event-pricing-accounting", () => {
  describe("extractCouponRules", () => {
    it("keeps only active coupon_code rules with a code", () => {
      const rules = extractCouponRules([
        {
          id: "rule-1",
          active: true,
          condition: { type: "coupon_code", code: "MTA2026" },
          adjustment: { mode: "percent", amount: 50 },
          message: "MTA discount",
        },
        {
          id: "rule-2",
          active: false,
          condition: { type: "coupon_code", code: "DEAD" },
          adjustment: { mode: "flat", amount: 100 },
        },
        {
          id: "rule-3",
          active: true,
          condition: { type: "early_bird" },
          adjustment: { mode: "flat", amount: 100 },
        },
        null,
      ]);
      expect(rules).toEqual([mtaRule]);
    });
  });

  describe("deriveDiscountEvidence", () => {
    it("sums per-seat discounts and surcharges and collects breakdown codes", () => {
      const derived = deriveDiscountEvidence({
        reference: "EVT-x",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "NGN",
        breakdown: [
          {
            basePrice: 7000,
            adjustment: -3500,
            appliedDiscounts: [{ couponCode: "MTA2026" }],
          },
        ],
      });
      expect(derived).toEqual({
        subtotalAmount: 7000,
        discountAmount: 3500,
        surchargeAmount: 0,
        breakdownCodes: ["MTA2026"],
        discountedSeats: [{ basePrice: 7000, absAdjustment: 3500 }],
      });
    });

    it("falls back to net adjustment_total when no breakdown exists", () => {
      const derived = deriveDiscountEvidence({
        reference: "EVT-y",
        base_total: 1000,
        adjustment_total: -250,
        currency: "NGN",
      });
      expect(derived.discountAmount).toBe(250);
      expect(derived.discountedSeats).toEqual([]);
    });

    it("returns zero evidence for empty snapshots", () => {
      const derived = deriveDiscountEvidence({
        reference: "EVT-z",
        base_total: null,
        adjustment_total: 0,
        currency: null,
      });
      expect(derived.subtotalAmount).toBeNull();
      expect(derived.discountAmount).toBe(0);
      expect(derived.surchargeAmount).toBe(0);
    });
  });

  describe("resolveAttribution", () => {
    const derivedWithBreakdown = deriveDiscountEvidence({
      reference: "r",
      base_total: 7000,
      adjustment_total: -3500,
      currency: "NGN",
      breakdown: [
        {
          basePrice: 7000,
          adjustment: -3500,
          appliedDiscounts: [{ couponCode: "MTA2026" }],
        },
      ],
    });

    it("prefers the snapshot breakdown code", () => {
      const attribution = resolveAttribution(derivedWithBreakdown, null, [
        mtaRule,
      ]);
      expect(attribution.code).toBe("MTA2026");
      expect(attribution.rule?.id).toBe("rule-1");
    });

    it("matches submitted codes case-insensitively against rules", () => {
      const derived = deriveDiscountEvidence({
        reference: "r",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "NGN",
        breakdown: [{ basePrice: 7000, adjustment: -3500 }],
      });
      const attribution = resolveAttribution(
        derived,
        "mta2026",
        [mtaRule],
      );
      expect(attribution.code).toBe("MTA2026");
      expect(attribution.rule?.id).toBe("rule-1");
    });

    it("keeps an unmatched submitted code but without a rule", () => {
      const derived = deriveDiscountEvidence({
        reference: "r",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "NGN",
        breakdown: [{ basePrice: 7000, adjustment: -3500 }],
      });
      const attribution = resolveAttribution(derived, "GHOSTCODE", [mtaRule]);
      expect(attribution.code).toBe("GHOSTCODE");
      expect(attribution.rule).toBeNull();
    });

    it("falls back to a sole rule whose math reproduces the discount", () => {
      const derived = deriveDiscountEvidence({
        reference: "r",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "NGN",
        breakdown: [{ basePrice: 7000, adjustment: -3500 }],
      });
      const attribution = resolveAttribution(derived, null, [mtaRule]);
      expect(attribution.code).toBe("MTA2026");
      expect(attribution.rule?.id).toBe("rule-1");
    });

    it("never attributes when nothing matches", () => {
      const derived = deriveDiscountEvidence({
        reference: "r",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "NGN",
        breakdown: [{ basePrice: 7000, adjustment: -3500 }],
      });
      const other = { ...mtaRule, value: 30 };
      const attribution = resolveAttribution(derived, null, [other]);
      expect(attribution.code).toBeNull();
      expect(attribution.rule).toBeNull();
    });
  });

  describe("extractSubmittedCoupon", () => {
    it("reads summary coupon first, then flat key", () => {
      expect(
        extractSubmittedCoupon({
          event_payment_summary: { coupon_code: "SUMMARY" },
          coupon_code: "FLAT",
        }),
      ).toBe("SUMMARY");
      expect(extractSubmittedCoupon({ coupon_code: " FLAT " })).toBe("FLAT");
      expect(extractSubmittedCoupon(null)).toBeNull();
    });
  });

  describe("buildOrderAccountingPatch", () => {
    it("builds full patch with attributed discount", () => {
      const snapshot = {
        reference: "EVT-a",
        base_total: 7000,
        adjustment_total: -3500,
        currency: "ngn",
        breakdown: [
          {
            basePrice: 7000,
            adjustment: -3500,
            appliedDiscounts: [{ couponCode: "MTA2026" }],
          },
        ],
      };
      const derived = deriveDiscountEvidence(snapshot);
      const attribution = resolveAttribution(derived, null, [mtaRule]);
      expect(buildOrderAccountingPatch(snapshot, derived, attribution)).toEqual(
        {
          subtotal_amount: 7000,
          discount_amount: 3500,
          surcharge_amount: 0,
          currency: "NGN",
          discount_code: "MTA2026",
          discount_details: [
            {
              rule_id: "rule-1",
              mode: "percent",
              value: 50,
              amount: 3500,
              coupon_code: "MTA2026",
              message: "MTA discount",
            },
          ],
        },
      );
    });

    it("nulls code/details when there is no discount", () => {
      const snapshot = {
        reference: "EVT-b",
        base_total: 1000,
        adjustment_total: 0,
        currency: "NGN",
      };
      const derived = deriveDiscountEvidence(snapshot);
      expect(buildOrderAccountingPatch(snapshot, derived, { code: null, rule: null })).toMatchObject(
        {
          subtotal_amount: 1000,
          discount_amount: 0,
          discount_code: null,
          discount_details: [],
        },
      );
    });
  });

  describe("deriveEventPaymentSummary", () => {
    it("reconstructs a full summary from snapshot evidence", () => {
      const summary = deriveEventPaymentSummary({
        snapshot: {
          reference: "EVT-c",
          base_total: 7000,
          adjustment_total: -3500,
          currency: "NGN",
          breakdown: [{ basePrice: 7000, adjustment: -3500 }],
        },
        couponRules: [mtaRule],
        submittedCode: "mta2026",
        verifiedAmount: 3708.13,
      });
      expect(summary).toMatchObject({
        currency: "NGN",
        subtotal: 7000,
        discount: 3500,
        surcharge: 0,
        amount: 3708.13,
        coupon_code: "MTA2026",
        coupon_applied: true,
      });
      expect(summary?.discounts?.[0]).toMatchObject({
        rule_id: "rule-1",
        mode: "percent",
        value: 50,
        amount: 3500,
      });
    });

    it("derives amount from pricing when no verified amount is given", () => {
      const summary = deriveEventPaymentSummary({
        snapshot: {
          reference: "EVT-d",
          base_total: 5000,
          adjustment_total: -1000,
          currency: "NGN",
        },
        couponRules: [],
        submittedCode: null,
      });
      expect(summary?.amount).toBe(4000);
    });

    it("returns undefined when there is nothing to price", () => {
      expect(
        deriveEventPaymentSummary({
          snapshot: {
            reference: "EVT-e",
            base_total: null,
            adjustment_total: 0,
            currency: "NGN",
          },
          couponRules: [],
          submittedCode: null,
        }),
      ).toBeUndefined();
    });
  });
});
