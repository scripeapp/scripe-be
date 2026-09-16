import { createPurchaseService } from "../services/purchase.service";

describe("event order discount accounting", () => {
  it("persists the buyer-currency discount snapshot on the order row", async () => {
    const insertedOrder = { id: "order-1" };
    const ordersChain: any = {
      upsert: jest.fn(),
      select: jest.fn(),
      maybeSingle: jest.fn().mockResolvedValue({
        data: insertedOrder,
        error: null,
      }),
    };
    ordersChain.upsert.mockReturnValue(ordersChain);
    ordersChain.select.mockReturnValue(ordersChain);

    const customerChain: any = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn().mockResolvedValue({
        data: { email: "buyer@example.com" },
        error: null,
      }),
    };
    customerChain.select.mockReturnValue(customerChain);
    customerChain.eq.mockReturnValue(customerChain);

    const usersChain: any = {
      select: jest.fn(),
      eq: jest.fn(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    usersChain.select.mockReturnValue(usersChain);
    usersChain.eq.mockReturnValue(usersChain);

    const db = {
      from: jest.fn((table: string) => {
        if (table === "customers") return customerChain;
        if (table === "users") return usersChain;
        if (table === "orders") return ordersChain;
        throw new Error(`Unexpected table: ${table}`);
      }),
    };

    const discount = {
      rule_id: "coupon-rule",
      mode: "percent" as const,
      value: 20,
      amount: 4,
      coupon_code: "SAVE20",
    };

    const result = await createPurchaseService(db as never).createOrder(
      "customer-1",
      "event-1",
      1698,
      "FLW-EVT-reference",
      {
        currency: "GHS",
        subtotal: 20,
        discount: 4,
        surcharge: 0,
        discountCode: "SAVE20",
        discounts: [discount],
      },
    );

    expect(result).toEqual(insertedOrder);
    expect(ordersChain.upsert).toHaveBeenCalledWith(
      {
        customer_id: "customer-1",
        user_id: undefined,
        event_id: "event-1",
        total_amount: 16.98,
        subtotal_amount: 20,
        discount_amount: 4,
        surcharge_amount: 0,
        currency: "GHS",
        discount_code: "SAVE20",
        discount_details: [discount],
        payment_reference: "FLW-EVT-reference",
      },
      { onConflict: "payment_reference", ignoreDuplicates: true },
    );
  });
});
