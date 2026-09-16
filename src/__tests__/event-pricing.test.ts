/**
 * Tests for the pure event pricing engine.
 */

/// <reference types="jest" />

import {
  computeAttendeePricing,
  assertAttendeeEmailsCoverSeats,
  rulesRequireAttendeeEmails,
  summarizePricingAdjustments,
  PricingRule,
} from "../utils/event-pricing";

const SEGMENT_ID = "seg-members";
const STANDARD_PRICE = 15000;
const SURCHARGE = 5000;
const COUPON_CODE = "SAVE20";
const COUPON_PERCENT = 20;

const tickets = [{ id: "tkt-1", ticket_price: STANDARD_PRICE }];

const surchargeRule: PricingRule = {
  id: "rule-1",
  active: true,
  condition: { type: "segment_membership", segment_id: SEGMENT_ID, match: "not_in" },
  adjustment: { type: "surcharge", mode: "flat", amount: SURCHARGE },
  applies_to: "per_attendee",
  redemption: { cap: 1 },
  message: "Non-members pay a surcharge.",
};

const members = (...emails: string[]) => ({
  [SEGMENT_ID]: new Set(emails.map((email) => email.toLowerCase())),
});

const couponRule: PricingRule = {
  id: "rule-coupon",
  active: true,
  condition: { type: "coupon_code", code: COUPON_CODE },
  adjustment: { type: "discount", mode: "percent", amount: COUPON_PERCENT },
  applies_to: "per_attendee",
  redemption: null,
  message: "Coupon SAVE20 applied.",
};

describe("computeAttendeePricing", () => {
  it("charges the standard price to a member", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "member@example.com",
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    expect(result.adjustmentTotal).toBe(0);
    expect(result.baseTotal).toBe(STANDARD_PRICE);
    expect(result.breakdown[0].tier).toBe("member");
  });

  it("surcharges a non-member", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    expect(result.adjustmentTotal).toBe(SURCHARGE);
    expect(result.breakdown[0].tier).toBe("surcharged");
    expect(result.breakdown[0].message).toBe(surchargeRule.message);
  });

  it("prices each seat by its own attendee email", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 2 },
      buyerEmail: "member@example.com",
      recipients: [{ ticketId: "tkt-1", email: "guest@example.com" }],
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    expect(result.adjustmentTotal).toBe(SURCHARGE); // member seat free, guest seat surcharged
    const tiers = result.breakdown.map((seat) => seat.tier).sort();
    expect(tiers).toEqual(["member", "surcharged"]);
  });

  it("is case-insensitive on email matching", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "Member@Example.com",
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    expect(result.adjustmentTotal).toBe(0);
  });

  it("surcharges member seats beyond the redemption cap within one order", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 2 },
      buyerEmail: "member@example.com",
      recipients: [{ ticketId: "tkt-1", email: "member@example.com" }],
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    // cap 1 → first member seat waived, second surcharged
    expect(result.adjustmentTotal).toBe(SURCHARGE);
  });

  it("respects redemptions already used in prior orders", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "member@example.com",
      rules: [surchargeRule],
      memberEmailsBySegment: members("member@example.com"),
      priorRedemptionsByEmail: { "member@example.com": 1 },
    });

    expect(result.adjustmentTotal).toBe(SURCHARGE); // cap already reached
    expect(result.breakdown[0].tier).toBe("surcharged");
  });

  it("applies no adjustment when there are no active rules", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [{ ...surchargeRule, active: false }],
      memberEmailsBySegment: members(),
    });

    expect(result.adjustmentTotal).toBe(0);
    expect(result.breakdown[0].tier).toBe("standard");
  });

  it("skips rules whose condition type is not registered", () => {
    const unknownRule: PricingRule = {
      ...surchargeRule,
      condition: { type: "location", city: "Lagos", match: "not_in" },
    };
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [unknownRule],
      memberEmailsBySegment: members(),
    });

    expect(result.adjustmentTotal).toBe(0);
  });

  it("supports percentage surcharges", () => {
    const percentRule: PricingRule = {
      ...surchargeRule,
      adjustment: { type: "surcharge", mode: "percent", amount: 20 },
    };
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [percentRule],
      memberEmailsBySegment: members("member@example.com"),
    });

    expect(result.adjustmentTotal).toBe(STANDARD_PRICE * 0.2);
  });
});

describe("computeAttendeePricing — coupon codes", () => {
  it("discounts every seat when the coupon code matches", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 2 },
      buyerEmail: "guest@example.com",
      recipients: [{ ticketId: "tkt-1", email: "friend@example.com" }],
      rules: [couponRule],
      memberEmailsBySegment: members(),
      couponCode: COUPON_CODE,
    });

    const discountPerSeat = -(STANDARD_PRICE * COUPON_PERCENT) / 100;
    expect(result.adjustmentTotal).toBe(discountPerSeat * 2);
    expect(result.breakdown[0].message).toBe(couponRule.message);
    expect(summarizePricingAdjustments(result)).toEqual({
      discountTotal: Math.abs(discountPerSeat * 2),
      surchargeTotal: 0,
      discounts: [
        expect.objectContaining({
          ruleId: couponRule.id,
          mode: "percent",
          value: COUPON_PERCENT,
          amount: Math.abs(discountPerSeat * 2),
          couponCode: COUPON_CODE,
        }),
      ],
    });
  });

  it("matches the coupon code case-insensitively", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [couponRule],
      memberEmailsBySegment: members(),
      couponCode: " save20 ",
    });

    expect(result.adjustmentTotal).toBe(-(STANDARD_PRICE * COUPON_PERCENT) / 100);
  });

  it("applies no discount when the coupon code does not match", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [couponRule],
      memberEmailsBySegment: members(),
      couponCode: "WRONGCODE",
    });

    expect(result.adjustmentTotal).toBe(0);
    expect(result.breakdown[0].message).toBeNull();
  });

  it("applies no discount when no coupon code is supplied", () => {
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [couponRule],
      memberEmailsBySegment: members(),
    });

    expect(result.adjustmentTotal).toBe(0);
  });

  it("supports a flat-amount coupon", () => {
    const flatCoupon: PricingRule = {
      ...couponRule,
      adjustment: { type: "discount", mode: "flat", amount: SURCHARGE },
    };
    const result = computeAttendeePricing({
      tickets,
      selectedTickets: { "tkt-1": 1 },
      buyerEmail: "guest@example.com",
      rules: [flatCoupon],
      memberEmailsBySegment: members(),
      couponCode: COUPON_CODE,
    });

    expect(result.adjustmentTotal).toBe(-SURCHARGE);
  });
});

describe("assertAttendeeEmailsCoverSeats", () => {
  it("passes when the buyer covers a single seat", () => {
    expect(() =>
      assertAttendeeEmailsCoverSeats({ "tkt-1": 1 }, []),
    ).not.toThrow();
  });

  it("throws when extra seats lack attendee emails", () => {
    expect(() =>
      assertAttendeeEmailsCoverSeats({ "tkt-1": 3 }, [
        { ticketId: "tkt-1", email: "guest@example.com" },
      ]),
    ).toThrow(/attendee email is required/i);
  });

  it("passes when every extra seat has a valid email", () => {
    expect(() =>
      assertAttendeeEmailsCoverSeats({ "tkt-1": 2 }, [
        { ticketId: "tkt-1", email: "guest@example.com" },
      ]),
    ).not.toThrow();
  });
});

describe("rulesRequireAttendeeEmails", () => {
  it("requires emails for segment rules that price by attendee identity", () => {
    expect(rulesRequireAttendeeEmails([surchargeRule])).toBe(true);
  });

  it("does not require emails for coupon-only orders", () => {
    expect(rulesRequireAttendeeEmails([couponRule])).toBe(false);
  });

  it("ignores inactive segment rules", () => {
    expect(
      rulesRequireAttendeeEmails([{ ...surchargeRule, active: false }]),
    ).toBe(false);
  });

  it("requires emails when a segment rule sits alongside a coupon", () => {
    expect(rulesRequireAttendeeEmails([couponRule, surchargeRule])).toBe(true);
  });
});
