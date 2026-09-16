/**
 * Tests for pricing-rule sanitisation on event create/update.
 */

/// <reference types="jest" />

import { sanitizePricingRules } from "../services/events.services";

const couponRule = {
  id: "rule-coupon",
  active: true,
  condition: { type: "coupon_code", code: "SAVE20" },
  adjustment: { type: "discount", mode: "percent", amount: 20 },
  applies_to: "per_attendee",
  redemption: null,
  message: "20% off",
};

const segmentRule = {
  id: "rule-segment",
  active: true,
  condition: { type: "segment_membership", segment_id: "seg-1", match: "not_in" },
  adjustment: { type: "surcharge", mode: "flat", amount: 5000 },
  applies_to: "per_attendee",
  redemption: { cap: 1 },
  message: "Non-members surcharge",
};

describe("sanitizePricingRules", () => {
  it("returns an empty array when rules are null", () => {
    expect(sanitizePricingRules(null)).toEqual([]);
  });

  it("throws when rules are not an array", () => {
    expect(() => sanitizePricingRules({} as unknown)).toThrow(
      /must be an array/i,
    );
  });

  it("preserves a coupon rule's code", () => {
    const [sanitized] = sanitizePricingRules([couponRule]);
    expect(sanitized.condition).toMatchObject({
      type: "coupon_code",
      code: "SAVE20",
    });
    expect(sanitized.adjustment.amount).toBe(20);
  });

  it("throws when a coupon rule has no code", () => {
    const missingCode = { ...couponRule, condition: { type: "coupon_code", code: "" } };
    expect(() => sanitizePricingRules([missingCode])).toThrow(
      /coupon_code rules require a code/i,
    );
  });

  it("throws when a segment rule has no segment_id", () => {
    const missingSegment = {
      ...segmentRule,
      condition: { type: "segment_membership", segment_id: "" },
    };
    expect(() => sanitizePricingRules([missingSegment])).toThrow(
      /require a segment_id/i,
    );
  });

  it("rejects a negative adjustment amount", () => {
    const negative = { ...couponRule, adjustment: { type: "discount", mode: "percent", amount: -5 } };
    expect(() => sanitizePricingRules([negative])).toThrow(
      /must be a positive number/i,
    );
  });
});
