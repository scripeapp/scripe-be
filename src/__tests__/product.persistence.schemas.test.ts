import { storeSchemas } from "../types/store.schemas";
import { ProductCoreSchema } from "../types/store";

describe("product persistence schemas", () => {
  const storeId = "11111111-1111-4111-8111-111111111111";
  const branchId = "22222222-2222-4222-8222-222222222222";
  const variantId = "33333333-3333-4333-8333-333333333333";

  it("accepts persisted option axes and values", () => {
    const result = ProductCoreSchema.shape.options_config.safeParse([
      { id: "size", name: "Size", values: ["Small", "Large"] },
      { id: "colour", name: "Colour", values: ["Black", "White"] },
    ]);

    expect(result.success).toBe(true);
  });

  it("preserves option definitions in a product update payload", () => {
    const options = [{ id: "size", name: "Size", values: ["Small", "Large"] }];
    const result = storeSchemas.updateProduct.safeParse({
      store_id: storeId,
      product_id: "44444444-4444-4444-8444-444444444444",
      updates: { options_config: options },
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.updates.options_config).toEqual(options);
  });

  it("accepts variant stock keyed by persisted variant UUID", () => {
    const result = storeSchemas.upsertProductBranchOverrides.safeParse({
      store_id: storeId,
      overrides: [{
        branch_id: branchId,
        stock_quantity: 12,
        variant_stock: { [variantId]: 7 },
      }],
    });

    expect(result.success).toBe(true);
  });

  it("distinguishes omitted inherited stock from explicit unlimited stock", () => {
    const inherited = storeSchemas.upsertProductBranchOverrides.parse({
      store_id: storeId,
      overrides: [{ branch_id: branchId, price: 1000 }],
    });
    const unlimited = storeSchemas.upsertProductBranchOverrides.parse({
      store_id: storeId,
      overrides: [{ branch_id: branchId, stock_quantity: null }],
    });

    expect("stock_quantity" in inherited.overrides[0]).toBe(false);
    expect(unlimited.overrides[0].stock_quantity).toBeNull();
  });

  it("accepts an explicitly unlimited branch variant", () => {
    const result = storeSchemas.upsertProductBranchOverrides.safeParse({
      store_id: storeId,
      overrides: [{ branch_id: branchId, variant_stock: { [variantId]: null } }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects branch variant stock with a temporary variant ID", () => {
    const result = storeSchemas.upsertProductBranchOverrides.safeParse({
      store_id: storeId,
      overrides: [{ branch_id: branchId, variant_stock: { "local-variant": 7 } }],
    });

    expect(result.success).toBe(false);
  });
});
