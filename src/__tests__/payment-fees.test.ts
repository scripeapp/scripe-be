/// <reference types="jest" />

import { calculateVaDepositFees, KOBOS_PER_NAIRA } from "../utils/payment/fees";

const nairaToKobo = (amount: number) => amount * KOBOS_PER_NAIRA;

describe("calculateVaDepositFees", () => {
  it("charges 1% to Paystack and 1% to Hilaq on a small deposit", () => {
    expect(calculateVaDepositFees(nairaToKobo(1000))).toEqual({
      paystackFee: 10,
      hilaqFee: 10,
      totalFee: 20,
    });
  });

  it("caps Paystack at 300 and the total at 500 on a 30,000 deposit", () => {
    expect(calculateVaDepositFees(nairaToKobo(30000))).toEqual({
      paystackFee: 300,
      hilaqFee: 200,
      totalFee: 500,
    });
  });

  it("hits the total cap exactly at 25,000", () => {
    expect(calculateVaDepositFees(nairaToKobo(25000))).toEqual({
      paystackFee: 250,
      hilaqFee: 250,
      totalFee: 500,
    });
  });

  it("keeps both fees at their caps on a large deposit", () => {
    expect(calculateVaDepositFees(nairaToKobo(100000))).toEqual({
      paystackFee: 300,
      hilaqFee: 200,
      totalFee: 500,
    });
  });

  it("rounds each fee share to the nearest kobo", () => {
    expect(calculateVaDepositFees(nairaToKobo(3333.33))).toEqual({
      paystackFee: 33.33,
      hilaqFee: 33.34,
      totalFee: 66.67,
    });
  });

  it("always leaves a non-negative Hilaq share under the shared cap", () => {
    for (let grossNaira = 100; grossNaira <= 100000; grossNaira += 100) {
      const fees = calculateVaDepositFees(nairaToKobo(grossNaira));
      expect(fees.hilaqFee).toBeGreaterThanOrEqual(0);
      expect(fees.paystackFee + fees.hilaqFee).toBeCloseTo(fees.totalFee, 2);
    }
  });
});
