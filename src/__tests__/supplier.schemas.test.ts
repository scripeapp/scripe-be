import { storeSchemas } from "../types/store.schemas";

describe("supplier persistence schemas", () => {
  const storeId = "11111111-1111-4111-8111-111111111111";
  const productId = "22222222-2222-4222-8222-222222222222";

  it("accepts a persisted supplier bill", () => {
    const result = storeSchemas.createSupplierBill.safeParse({
      store_id: storeId,
      bill_number: "BIL-1001",
      amount: 125000,
      currency: "NGN",
      issue_date: "2026-08-28",
      due_date: "2026-09-27",
      status: "pending",
      items_count: 3,
    });

    expect(result.success).toBe(true);
  });

  it("rejects a non-positive supplier bill amount", () => {
    const result = storeSchemas.createSupplierBill.safeParse({
      store_id: storeId,
      bill_number: "BIL-1002",
      amount: 0,
      currency: "NGN",
      issue_date: "2026-08-28",
    });

    expect(result.success).toBe(false);
  });

  it("accepts a stock receipt with unit cost and notes", () => {
    const result = storeSchemas.updateInventory.safeParse({
      store_id: storeId,
      updates: [{
        product_id: productId,
        quantity_change: 25,
        reason: "restock",
        unit_cost: 450,
        notes: "August supplier delivery",
      }],
    });

    expect(result.success).toBe(true);
  });

  it("rejects a zero-quantity stock receipt", () => {
    const result = storeSchemas.updateInventory.safeParse({
      store_id: storeId,
      updates: [{ product_id: productId, quantity_change: 0, reason: "restock" }],
    });

    expect(result.success).toBe(false);
  });
});
