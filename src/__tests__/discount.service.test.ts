import {
  DiscountService,
  isDiscountAvailable,
} from "../services/discount.service";
import type { DiscountCode } from "../types/store";

const baseDiscount = (overrides: Partial<DiscountCode> = {}): DiscountCode => ({
  id: "00000000-0000-4000-8000-000000000001",
  store_id: "00000000-0000-4000-8000-000000000010",
  kind: "automatic",
  name: "Spend and save",
  code: null,
  type: "percentage",
  value: 10,
  is_active: true,
  usage_count: 0,
  max_usage: null,
  one_use_per_customer: false,
  starts_at: null,
  expires_at: null,
  applies_to: "all",
  product_ids: [],
  trigger: "spend_threshold",
  trigger_value: 5_000,
  qualification_product_ids: [],
  allow_code_on_top: false,
  show_on_storefront: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const createSupabaseMock = (
  automaticDiscounts: DiscountCode[],
  codeDiscount: DiscountCode | null = null,
) => {
  const from = jest.fn((table: string) => {
    let discountKind: string | undefined;
    const builder: Record<string, jest.Mock> = {};
    builder.select = jest.fn(() => builder);
    builder.eq = jest.fn((column: string, value: unknown) => {
      if (column === "kind") discountKind = String(value);
      return builder;
    });
    builder.ilike = jest.fn(() => builder);
    builder.in = jest.fn().mockResolvedValue({ data: [], error: null, count: 0 });
    builder.limit = jest.fn().mockImplementation(async () => ({
      data: discountKind === "automatic" ? automaticDiscounts : [],
      error: null,
    }));
    builder.maybeSingle = jest.fn().mockImplementation(async () => ({
      data: discountKind === "code" ? codeDiscount : null,
      error: null,
    }));

    if (table === "store_orders") {
      builder.in.mockResolvedValue({ data: [], error: null, count: 0 });
    }
    return builder;
  });

  return { from };
};

describe("DiscountService", () => {
  const cart = [
    { product_id: "product-a", quantity: 2, line_total: 6_000 },
    { product_id: "product-b", quantity: 1, line_total: 4_000 },
  ];

  it("rejects inactive, future, expired, and exhausted discounts", () => {
    const now = new Date("2026-09-01T12:00:00.000Z");

    expect(isDiscountAvailable(baseDiscount({ is_active: false }), now)).toBe(false);
    expect(
      isDiscountAvailable(
        baseDiscount({ starts_at: "2026-09-02T00:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
    expect(
      isDiscountAvailable(
        baseDiscount({ expires_at: "2026-09-01T00:00:00.000Z" }),
        now,
      ),
    ).toBe(false);
    expect(
      isDiscountAvailable(baseDiscount({ max_usage: 2, usage_count: 2 }), now),
    ).toBe(false);
  });

  it("applies a qualifying spend-threshold discount", async () => {
    const supabase = createSupabaseMock([baseDiscount()]);
    const service = new DiscountService(supabase as never);

    const result = await service.evaluate({ storeId: "store", items: cart });

    expect(result.automatic_discount?.name).toBe("Spend and save");
    expect(result.discount_amount).toBe(1_000);
    expect(result.code_error).toBeUndefined();
  });

  it("uses qualification products for quantity triggers", async () => {
    const discount = baseDiscount({
      trigger: "quantity_bought",
      trigger_value: 2,
      qualification_product_ids: ["product-a"],
    });
    const service = new DiscountService(
      createSupabaseMock([discount]) as never,
    );

    const result = await service.evaluate({ storeId: "store", items: cart });

    expect(result.automatic_discount).not.toBeNull();
  });

  it("selects the qualifying automatic discount with the largest saving", async () => {
    const smaller = baseDiscount({
      id: "00000000-0000-4000-8000-000000000002",
      value: 5,
    });
    const larger = baseDiscount({
      id: "00000000-0000-4000-8000-000000000003",
      name: "Best discount",
      type: "fixed",
      value: 2_000,
    });
    const service = new DiscountService(
      createSupabaseMock([smaller, larger]) as never,
    );

    const result = await service.evaluate({ storeId: "store", items: cart });

    expect(result.automatic_discount?.name).toBe("Best discount");
    expect(result.discount_amount).toBe(2_000);
  });

  it("stacks a code only when the selected automatic discount allows it", async () => {
    const code = baseDiscount({
      id: "00000000-0000-4000-8000-000000000004",
      kind: "code",
      name: null,
      code: "SAVE5",
      trigger: null,
      type: "fixed",
      value: 500,
    });
    const blockedService = new DiscountService(
      createSupabaseMock([baseDiscount()], code) as never,
    );
    const stackedService = new DiscountService(
      createSupabaseMock([baseDiscount({ allow_code_on_top: true })], code) as never,
    );

    const blocked = await blockedService.evaluate({
      storeId: "store",
      items: cart,
      code: "SAVE5",
    });
    const stacked = await stackedService.evaluate({
      storeId: "store",
      items: cart,
      code: "SAVE5",
    });

    expect(blocked.code_discount).toBeNull();
    expect(blocked.code_error).toMatch(/cannot be combined/i);
    expect(stacked.code_discount?.code).toBe("SAVE5");
    expect(stacked.discount_amount).toBe(1_500);
  });

  it("requires customer identity before evaluating first-order discounts", async () => {
    const discount = baseDiscount({ trigger: "first_order", trigger_value: null });
    const service = new DiscountService(
      createSupabaseMock([discount]) as never,
    );

    const result = await service.evaluate({ storeId: "store", items: cart });

    expect(result.automatic_discount).toBeNull();
    expect(result.requires_customer_identity).toBe(true);
  });
});
