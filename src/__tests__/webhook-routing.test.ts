import { classifyPaystackEvent } from "../utils/payment/webhook-routing";

const envelope = (
  event: string,
  data: Record<string, unknown> = {},
) => ({ event, data });

describe("classifyPaystackEvent", () => {
  it("routes a declared product payment to the product pipeline even with business_id", () => {
    const result = classifyPaystackEvent(
      envelope("charge.success", {
        reference: "EVT-11af050e-1787344529887",
        metadata: {
          business_id: "75aad067-54f2-4b41-8070-2f312573d3f3",
          transaction_type: "event_ticket",
          event_id: "evt-1",
        },
      }),
    );

    expect(result).toBe("product");
  });

  it.each([
    "store_purchase",
    "tipping",
    "course_purchase",
    "cohort_enrollment",
    "scheduling_payment",
    "form_submission",
    "booking_payment",
  ])("routes %s payments to the product pipeline", (transactionType) => {
    const result = classifyPaystackEvent(
      envelope("charge.success", {
        metadata: { business_id: "biz-1", transaction_type: transactionType },
      }),
    );

    expect(result).toBe("product");
  });

  it("routes a declared business subscription charge to the subscription handler", () => {
    const result = classifyPaystackEvent(
      envelope("charge.success", {
        metadata: {
          business_id: "biz-1",
          transaction_type: "business_subscription",
        },
      }),
    );

    expect(result).toBe("business_subscription");
  });

  it("routes an untyped recurring charge carrying a subscription_code to the subscription handler", () => {
    const result = classifyPaystackEvent(
      envelope("charge.success", {
        subscription_code: "SUB_xxxx",
        metadata: { business_id: "biz-1", plan: "pro" },
      }),
    );

    expect(result).toBe("business_subscription");
  });

  it.each([
    "subscription.create",
    "subscription.enable",
    "subscription.disable",
    "subscription.not_renew",
    "direct_debit.authorization.created",
    "invoice.payment_failed",
  ])(
    "routes business-owned lifecycle event %s to the subscription handler",
    (eventName) => {
      const result = classifyPaystackEvent(
        envelope(eventName, { metadata: { business_id: "biz-1" } }),
      );

      expect(result).toBe("business_subscription");
    },
  );

  it("keeps untyped lifecycle events without business_id on the product pipeline (publication subscriptions)", () => {
    const result = classifyPaystackEvent(
      envelope("subscription.create", { metadata: { user_id: "user-1" } }),
    );

    expect(result).toBe("product");
  });

  it("no longer hijacks plain untyped charges just because they carry business_id", () => {
    const result = classifyPaystackEvent(
      envelope("charge.success", {
        reference: "EVT-abcd1234-1787344529887",
        metadata: {
          business_id: "75aad067-54f2-4b41-8070-2f312573d3f3",
          full_name: "Buyer",
          email: "buyer@test.com",
        },
      }),
    );

    expect(result).toBe("product");
  });

  it("routes events without any routing signals to the product pipeline", () => {
    const result = classifyPaystackEvent(
      envelope("settlement.success", { data: undefined } as never),
    );

    expect(result).toBe("product");
  });
});
