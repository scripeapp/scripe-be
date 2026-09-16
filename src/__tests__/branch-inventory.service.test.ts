import { StoreService } from "../services/store.service";
import { createMockQueryBuilder } from "./test-utils";

describe("unified decrement_product_stock checkout", () => {
  const item = {
    product_id: "11111111-1111-4111-8111-111111111111",
    product_name: "Branch product",
    variant_id: "22222222-2222-4222-8222-222222222222",
    quantity: 2,
  };

  const buildClient = () => {
    const variantQuery = createMockQueryBuilder({
      id: item.variant_id,
      product_id: item.product_id,
    });
    const productQuery = createMockQueryBuilder({
      id: item.product_id,
      orders_count: 3,
      type: "physical",
      bundle: null,
    });
    const client = {
      from: jest.fn((table: string) =>
        table === "product_variants" ? variantQuery : productQuery,
      ),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const service = new StoreService(client as never);
    (service as any).getInventoryClient = () => client;
    return { service, client, variantQuery, productQuery };
  };

  it("makes a single unified RPC call for a branch sale and bumps orders_count only", async () => {
    const { service, client, variantQuery, productQuery } = buildClient();

    await (service as any).decrementInventoryForOrderItems(
      [item],
      "branch-1",
      { reference_id: "order-1", created_by: "user-1" },
    );

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("decrement_product_stock", {
      p_product_id: item.product_id,
      p_branch_id: "branch-1",
      p_quantity: 2,
      p_variant_id: item.variant_id,
      p_reason: "sale",
      p_reference_id: "order-1",
      p_created_by: "user-1",
    });
    // The RPC owns stock; JS only bumps the counter.
    expect(productQuery.update).toHaveBeenCalledWith({ orders_count: 5 });
    expect(variantQuery.update).not.toHaveBeenCalled();
  });

  it("makes a single unified RPC call for a global sale (branch_id null)", async () => {
    const { service, client, productQuery } = buildClient();

    await (service as any).decrementInventoryForOrderItems(
      [item],
      undefined,
      { reference_id: "order-1", created_by: "user-1" },
    );

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith(
      "decrement_product_stock",
      expect.objectContaining({
        p_product_id: item.product_id,
        p_branch_id: null,
        p_reason: "sale",
      }),
    );
    expect(productQuery.update).toHaveBeenCalledWith({ orders_count: 5 });
  });

  it("translates an RPC insufficient-stock (P0001) error into a 409", async () => {
    const { service, client } = buildClient();
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "Insufficient stock" },
    });

    await expect(
      (service as any).decrementInventoryForOrderItems(
        [item],
        "branch-1",
        { reference_id: "order-1", created_by: "user-1" },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it("throws a 400 when the variant does not belong to the declared product", async () => {
    const { service, client } = buildClient();
    client.from = jest.fn((table: string) => {
      const q = createMockQueryBuilder({
        id: "other-variant",
        product_id: "other-product",
      });
      const p = createMockQueryBuilder({
        id: item.product_id,
        orders_count: 0,
        type: "physical",
        bundle: null,
      });
      return table === "product_variants" ? q : p;
    });

    await expect(
      (service as any).decrementInventoryForOrderItems(
        [item],
        "branch-1",
        {},
      ),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("bundle component stock movements", () => {
  it("runs each tracked component through the unified RPC and skips untracked ones", async () => {
    const bundledProducts = createMockQueryBuilder([
      { id: "comp-1", name: "Comp A", stock: 10 },
      { id: "comp-2", name: "Comp B", stock: null },
    ]);
    const other = createMockQueryBuilder(null);
    const client = {
      from: jest.fn((table: string) =>
        table === "products" ? bundledProducts : other,
      ),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const service = new StoreService(client as never);
    (service as any).getInventoryClient = () => client;

    await (service as any).decrementBundledProductStock(
      client,
      { product_ids: ["comp-1", "comp-2"] },
      3,
      { reference_id: "order-1", created_by: "user-1" },
    );

    // comp-2 is untracked (null stock) -> skipped; only comp-1 is decremented.
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("decrement_product_stock", {
      p_product_id: "comp-1",
      p_branch_id: null,
      p_quantity: 3,
      p_variant_id: null,
      p_reason: "sale",
      p_reference_id: "order-1",
      p_created_by: "user-1",
    });
    expect(bundledProducts.update).not.toHaveBeenCalled();
  });

  it("throws a friendly 409 when a bundled product is out of stock and makes no RPC call", async () => {
    const bundledProducts = createMockQueryBuilder([
      { id: "comp-1", name: "Comp A", stock: 2 },
    ]);
    const other = createMockQueryBuilder(null);
    const client = {
      from: jest.fn((table: string) =>
        table === "products" ? bundledProducts : other,
      ),
      rpc: jest.fn().mockResolvedValue({ data: null, error: null }),
    };
    const service = new StoreService(client as never);
    (service as any).getInventoryClient = () => client;

    await expect(
      (service as any).decrementBundledProductStock(
        client,
        { product_ids: ["comp-1"] },
        3,
        { reference_id: "order-1", created_by: "user-1" },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: 'Insufficient stock for "Comp A" (part of bundle)',
    });

    expect(client.rpc).not.toHaveBeenCalled();
    expect(bundledProducts.update).not.toHaveBeenCalled();
  });
});

describe("normalized branch inventory override persistence", () => {
  const storeId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const productId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const branchId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const variantId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  it("projects mixed-grain inventory rows back into the branch editor DTO", async () => {
    const catalogQuery = createMockQueryBuilder([
      {
        id: "catalog-row",
        product_id: productId,
        branch_id: branchId,
        is_available: false,
        price: 1250,
        currency_prices: null,
        lead_time_hours: 2,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        product: { store_id: storeId },
      },
    ]);
    const inventoryQuery = createMockQueryBuilder([
      {
        id: "base-stock-row",
        product_id: productId,
        branch_id: branchId,
        variant_id: null,
        stock_quantity: null,
        reserved_quantity: 0,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        product: { store_id: storeId },
      },
      {
        id: "variant-stock-row",
        product_id: productId,
        branch_id: branchId,
        variant_id: variantId,
        stock_quantity: 7,
        reserved_quantity: 0,
        created_at: "2026-08-29T00:00:00.000Z",
        updated_at: "2026-08-29T00:00:00.000Z",
        product: { store_id: storeId },
      },
    ]);
    const client = {
      from: jest.fn((table: string) =>
        table === "branch_catalog_overrides" ? catalogQuery : inventoryQuery,
      ),
    };
    const service = new StoreService(client as never);

    const result = await service.getProductBranchOverrides(storeId, productId);

    expect(result).toEqual([
      expect.objectContaining({
        branch_id: branchId,
        stock_quantity: null,
        reserved_quantity: 0,
        variant_stock: { [variantId]: 7 },
      }),
    ]);
    expect(inventoryQuery.select).toHaveBeenCalledWith(
      expect.stringContaining("variant_id, stock_quantity"),
    );
  });

  it("writes product and variant balances as separate narrow rows", async () => {
    const productQuery = createMockQueryBuilder({ id: productId });
    const branchesQuery = createMockQueryBuilder([{ id: branchId }]);
    const variantsQuery = createMockQueryBuilder([{ id: variantId }]);
    const deleteCatalog = createMockQueryBuilder(null);
    const insertCatalog = createMockQueryBuilder(null);
    const deleteInventory = createMockQueryBuilder(null);
    const insertInventory = createMockQueryBuilder(null);
    let catalogCall = 0;
    let inventoryCall = 0;
    const client = {
      from: jest.fn((table: string) => {
        if (table === "products") return productQuery;
        if (table === "store_branches") return branchesQuery;
        if (table === "product_variants") return variantsQuery;
        if (table === "branch_catalog_overrides") {
          return catalogCall++ === 0 ? deleteCatalog : insertCatalog;
        }
        if (table === "branch_inventory_overrides") {
          return inventoryCall++ === 0 ? deleteInventory : insertInventory;
        }
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const service = new StoreService(client as never);
    jest.spyOn(service, "getProductBranchOverrides").mockResolvedValue([]);

    await service.upsertProductBranchOverrides(storeId, productId, [
      {
        branch_id: branchId,
        is_available: false,
        price: 1250,
        stock_quantity: 12,
        variant_stock: { [variantId]: null },
      },
    ]);

    expect(insertCatalog.insert).toHaveBeenCalledWith([
      expect.objectContaining({
        product_id: productId,
        branch_id: branchId,
        is_available: false,
        price: 1250,
      }),
    ]);
    expect(insertCatalog.insert.mock.calls[0][0][0]).not.toHaveProperty(
      "stock_quantity",
    );
    expect(insertInventory.insert).toHaveBeenCalledWith([
      {
        product_id: productId,
        branch_id: branchId,
        variant_id: null,
        stock_quantity: 12,
        reserved_quantity: 0,
      },
      {
        product_id: productId,
        branch_id: branchId,
        variant_id: variantId,
        stock_quantity: null,
        reserved_quantity: 0,
      },
    ]);
  });

  it("does not create an inventory row when stock is omitted", async () => {
    const productQuery = createMockQueryBuilder({ id: productId });
    const branchesQuery = createMockQueryBuilder([{ id: branchId }]);
    const deleteCatalog = createMockQueryBuilder(null);
    const insertCatalog = createMockQueryBuilder(null);
    const deleteInventory = createMockQueryBuilder(null);
    let catalogCall = 0;
    const client = {
      from: jest.fn((table: string) => {
        if (table === "products") return productQuery;
        if (table === "store_branches") return branchesQuery;
        if (table === "branch_catalog_overrides") {
          return catalogCall++ === 0 ? deleteCatalog : insertCatalog;
        }
        if (table === "branch_inventory_overrides") return deleteInventory;
        throw new Error(`Unexpected table ${table}`);
      }),
    };
    const service = new StoreService(client as never);
    jest.spyOn(service, "getProductBranchOverrides").mockResolvedValue([]);

    await service.upsertProductBranchOverrides(storeId, productId, [
      { branch_id: branchId, price: 1250 },
    ]);

    expect(deleteInventory.delete).toHaveBeenCalled();
    expect(client.from).toHaveBeenCalledWith("branch_inventory_overrides");
    expect(deleteInventory.insert).not.toHaveBeenCalled();
  });
});
