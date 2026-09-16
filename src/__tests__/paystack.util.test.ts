/**
 * Tests for the checkout fee maths.
 *
 * resolveCustomerCharge is the single source of truth shared by store checkout
 * and payment verification, so these cases pin down the money invariant that
 * must hold between charging and verifying a payment.
 */

import {
  calculateTotalWithFees,
  getPlatformFeePercent,
  resolveCustomerCharge,
} from "../utils/payment/fees";

describe("resolveCustomerCharge", () => {
  const BASE = 10_000;

  it("grosses the full fee onto the bill when the customer bears it", () => {
    const full = calculateTotalWithFees(BASE);
    const charge = resolveCustomerCharge(BASE, "customer");

    expect(charge.totalToCharge).toBe(full.totalToCharge);
    expect(charge.totalToCharge).toBeGreaterThan(BASE);
  });

  it("charges the customer the list price when the merchant bears the fee", () => {
    const charge = resolveCustomerCharge(BASE, "subaccount");

    expect(charge.totalToCharge).toBe(BASE);
    expect(charge.gatewayFee).toBe(0);
    expect(charge.platformFee).toBe(calculateTotalWithFees(BASE).platformFee);
  });

  it("charges the customer exactly half the combined fee when split", () => {
    const full = calculateTotalWithFees(BASE);
    const combinedFee = full.totalToCharge - BASE;
    const charge = resolveCustomerCharge(BASE, "split");

    expect(charge.totalToCharge).toBeCloseTo(BASE + combinedFee / 2, 2);
  });

  it("keeps the split charge midway between the customer- and merchant-borne charges", () => {
    const customer = resolveCustomerCharge(BASE, "customer").totalToCharge;
    const merchant = resolveCustomerCharge(BASE, "subaccount").totalToCharge;
    const split = resolveCustomerCharge(BASE, "split").totalToCharge;

    expect(split).toBeCloseTo((customer + merchant) / 2, 2);
  });

  it("always routes the full platform fee regardless of who bears the gateway fee", () => {
    const expectedPlatformFee = calculateTotalWithFees(BASE).platformFee;

    expect(resolveCustomerCharge(BASE, "customer").platformFee).toBe(expectedPlatformFee);
    expect(resolveCustomerCharge(BASE, "subaccount").platformFee).toBe(expectedPlatformFee);
    expect(resolveCustomerCharge(BASE, "split").platformFee).toBe(expectedPlatformFee);
  });

  it("handles small amounts below the Paystack flat-fee waiver limit", () => {
    const smallBase = 1_000;
    const full = calculateTotalWithFees(smallBase);
    const split = resolveCustomerCharge(smallBase, "split");

    expect(split.totalToCharge).toBeCloseTo(smallBase + (full.totalToCharge - smallBase) / 2, 2);
    expect(split.totalToCharge).toBeGreaterThan(smallBase);
  });
});

describe("resolveCustomerCharge — flutterwave provider", () => {
  const BASE_GHS = 16.47; // the real-world GHS charge that settled negative

  it("uses Flutterwave pricing, not Paystack NGN maths", () => {
    const charge = resolveCustomerCharge(BASE_GHS, "customer", {
      provider: "flutterwave",
      currency: "GHS",
    });

    // 2% international platform fee on the base
    expect(charge.platformFee).toBeCloseTo(BASE_GHS * 0.02, 2);
    // gateway estimate = (base + platform) at the published GHS card rate
    const intermediate = BASE_GHS + charge.platformFee;
    expect(charge.gatewayFee).toBeCloseTo(
      Math.ceil(intermediate * 0.026 * 100) / 100,
      5,
    );
    expect(charge.totalToCharge).toBeCloseTo(
      BASE_GHS + charge.platformFee + charge.gatewayFee,
      5,
    );
  });

  it("keeps fee-bearing consistent with Paystack bearer semantics", () => {
    for (const feeBearer of ["customer", "subaccount", "split"] as const) {
      const charge = resolveCustomerCharge(BASE_GHS, feeBearer, {
        provider: "flutterwave",
        currency: "GHS",
      });

      if (feeBearer === "subaccount") {
        // merchant absorbs fees: customer pays the list price
        expect(charge.totalToCharge).toBe(BASE_GHS);
        continue;
      }
      // customer covers some or all of the combined fee on top of the base
      expect(charge.totalToCharge).toBeGreaterThan(BASE_GHS);
      expect(charge.totalToCharge).toBeCloseTo(
        feeBearer === "customer"
          ? BASE_GHS + charge.platformFee + charge.gatewayFee
          : BASE_GHS + (charge.platformFee + charge.gatewayFee) / 2,
        2, // minor-unit tolerance: halved fees can land on half-cent ties
      );
    }
  });

  it("applies the domestic rate only to NGN", () => {
    expect(getPlatformFeePercent("NGN")).toBe(0.015);
    for (const intl of ["GHS", "USD", "GBP", "KES", "ZAR"]) {
      expect(getPlatformFeePercent(intl)).toBe(0.02);
    }
  });

  it("defaults to the Paystack NGN path when no context is given", () => {
    const legacy = resolveCustomerCharge(BASE_GHS, "customer");
    const explicit = resolveCustomerCharge(BASE_GHS, "customer", {
      provider: "paystack",
      currency: "NGN",
    });
    expect(legacy).toEqual(explicit);
    expect(legacy.platformFee).toBe(calculateTotalWithFees(BASE_GHS).platformFee);
  });
});
