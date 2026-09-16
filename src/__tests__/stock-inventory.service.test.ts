import { StoreService } from "../services/store.service";
import { createMockQueryBuilder } from "./test-utils";

const uuid = (s: string) =>
  `${s}${s}${s}${s}-${s}${s}${s}${s}-4${s}${s}${s}${s}-8${s}${s}${s}${s}-${s}${s}${s}${s}${s}${s}${s}${s}${s}${s}${s}${s}`;

const storeId = uuid("a");
const branchId = uuid("b");
const branch2Id = uuid("c");
const productId = uuid("d");
const variantId = uuid("e");
const userId = uuid("f");
const transferId = uuid("1");
const countId = uuid("2");

/**
 * A Supabase mock that returns a chained query builder per table. The builder
 * resolves whatever `rows` were supplied, so awaiting `.single()` /
 * `.maybeSingle()` yields `{ data, error }` just like the real client.
 */
const buildClient = (tables: Record<string, any>, rpcError: any = null) => {
  const from = jest.fn((table: string) => {
    if (!(table in tables)) {
      return createMockQueryBuilder(null, rpcError ? { error: rpcError } : null);
    }
    return createMockQueryBuilder(tables[table]);
  });
  const rpc = jest.fn().mockResolvedValue(
    rpcError ? { data: null, error: rpcError } : { data: null, error: null },
  );
  return { client: { from, rpc } as any, from, rpc };
};

describe("bulkUpdateStock", () => {
  it("adjusts a branch override and uses the null-operator for the product grain lookup", async () => {
    const storedOne = createMockQueryBuilder(null); // stock_movements insert
    const overrideLoop = createMockQueryBuilder(null); // branch override select (empty)
    const { client, from } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "products") return createMockQueryBuilder({ id: productId });
      if (table === "store_branches") return createMockQueryBuilder({ id: branchId });
      if (table === "stock_movements") return storedOne;
      if (table === "branch_inventory_overrides") return overrideLoop;
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);

    await service.bulkUpdateStock(
      storeId,
      [
        {
          product_id: productId,
          branch_id: branchId,
          quantity_change: 3,
          reason: "theft",
          effective_at: "2026-09-02T00:00:00.000Z",
        },
      ],
      userId,
    );

    // The stock movement row carries the adjustment.
    expect(storedOne.insert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "theft", quantity_change: 3 }),
    );
    // The branch override lookup must filter null with `.is()`, never `.eq()`,
    // or Postgres rejects it with invalid input syntax for type uuid: "null".
    expect(overrideLoop.is).toHaveBeenCalledWith("variant_id", null);
    expect(overrideLoop.eq).not.toHaveBeenCalledWith("variant_id", null);
  });

  it("updates a sparse branch override when one already exists", async () => {
    const brute = createMockQueryBuilder(null);
    const existing = {
      id: "override-row-1",
      stock_quantity: 10,
    };
    const branchOverrideQuery = createMockQueryBuilder(existing);
    const { client, from } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "products") return createMockQueryBuilder({ id: productId });
      if (table === "store_branches") return createMockQueryBuilder({ id: branchId });
      if (table === "stock_movements") return brute;
      if (table === "branch_inventory_overrides") return branchOverrideQuery;
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);

    await service.bulkUpdateStock(
      storeId,
      [{ product_id: productId, branch_id: branchId, quantity_change: 5, reason: "found" }],
      userId,
    );

    expect(existing).toHaveProperty("id", "override-row-1");
    expect(branchOverrideQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ stock_quantity: 15 }),
    );
  });

  it("decrements the flat product stock when no branch is supplied", async () => {
    const productQuery = createMockQueryBuilder({ id: productId, stock: 10 });
    const movementInsert = createMockQueryBuilder(null);
    const { client, from } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "products") return productQuery;
      if (table === "stock_movements") return movementInsert;
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);

    await service.bulkUpdateStock(
      storeId,
      [{ product_id: productId, quantity_change: -2, reason: "damaged" }],
      userId,
    );

    expect(productQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ stock: 8 }),
    );
    expect(movementInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "damaged", quantity_change: -2 }),
    );
  });
});

describe("stock counts", () => {
  it("creates a count header and captures its lines", async () => {
    const headerInsert = createMockQueryBuilder({ id: countId, reference: "SC-0001" });
    const costRows = [{ id: productId, cost: "500" }];
    const overrideQuery = createMockQueryBuilder({ stock_quantity: 6 });
    const { client, from } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "store_branches") return createMockQueryBuilder({ id: branchId });
      if (table === "stock_counts") return headerInsert;
      if (table === "products") return createMockQueryBuilder(costRows);
      if (table === "branch_inventory_overrides") return overrideQuery;
      if (table === "stock_count_lines") return createMockQueryBuilder(null);
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);

    const result = await service.createStockCount(
      storeId,
      {
        reference: "SC-0001",
        branch_id: branchId,
        lines: [{ product_id: productId, counted_quantity: 4 }],
      },
      userId,
    );

    expect(result).toEqual({ id: countId, reference: "SC-0001" });
    expect(headerInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ branch_id: branchId, scope: "all", counted_by: userId }),
    );
    // The product-grain on-hand lookup used `.is()` too.
    expect(overrideQuery.is).toHaveBeenCalledWith("variant_id", null);
  });

  it("applies a draft count: posts a count reason movement and marks it applied", async () => {
    const countRow = {
      id: countId,
      status: "draft",
      branch_id: branchId,
      count_date: "2026-09-01T00:00:00.000Z",
      reference: "SC-0001",
    };
    const lines = [
      {
        id: "line-1",
        product_id: productId,
        variant_id: null,
        system_quantity: 6,
        counted_quantity: 8,
      },
    ];
    const { client, from } = buildClient({});
    const countQuery = createMockQueryBuilder(countRow); // load header
    const movementInsert = createMockQueryBuilder(null);
    const branchOverrideQuery = createMockQueryBuilder({
      id: "override-row",
      stock_quantity: 6,
    });
    from.mockImplementation((table: string) => {
      if (table === "stock_counts") return countQuery;
      if (table === "stock_count_lines") return createMockQueryBuilder(lines);
      if (table === "stock_movements") return movementInsert;
      if (table === "branch_inventory_overrides") return branchOverrideQuery;
      return createMockQueryBuilder(null);
    });
    countQuery.maybeSingle.mockResolvedValue({ data: countRow, error: null });

    const service = new StoreService(client);

    await service.applyStockCount(storeId, countId, userId);

    expect(movementInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "count", quantity_change: 2 }),
    );
    expect(countQuery.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "applied" }),
    );
  });
});

describe("stock transfers", () => {
  it("creates a draft transfer header and its lines", async () => {
    const headerInsert = createMockQueryBuilder({ id: transferId, reference: "TR-0001" });
    const linesInsert = createMockQueryBuilder(null);
    const { client, from } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "stock_transfers") return headerInsert;
      if (table === "store_branches") return createMockQueryBuilder({ id: branchId });
      if (table === "stock_transfer_lines") return linesInsert;
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);

    const result = await service.createStockTransfer(storeId, {
      reference: "TR-0001",
      from_branch_id: branchId,
      to_branch_id: branch2Id,
      lines: [{ product_id: productId, variant_id: variantId, quantity: 3 }],
    });

    expect(result).toEqual({ id: transferId, reference: "TR-0001" });
    expect(headerInsert.insert).toHaveBeenCalledWith(
      expect.objectContaining({ from_branch_id: branchId, to_branch_id: branch2Id }),
    );
    expect(linesInsert.insert).toHaveBeenCalledWith([
      {
        transfer_id: transferId,
        product_id: productId,
        variant_id: variantId,
        quantity: 3,
        received_quantity: 0,
        unit_cost: null,
      },
    ]);
  });

  it("dispatches a transfer via decrement_product_stock with transfer_out reason", async () => {
    const transferRow = {
      id: transferId,
      status: "draft",
      from_branch_id: branchId,
      to_branch_id: branch2Id,
    };
    const lines = [{ transfer_id: transferId, product_id: productId, variant_id: variantId, quantity: 3 }];
    const { client, from, rpc } = buildClient({});
    from.mockImplementation((table: string) => {
      if (table === "stock_transfers") return createMockQueryBuilder(transferRow);
      if (table === "stock_transfer_lines") return createMockQueryBuilder(lines);
      if (table === "products") return createMockQueryBuilder({ id: productId });
      if (table === "branch_inventory_overrides") {
        return createMockQueryBuilder({ id: "row", stock_quantity: 10 });
      }
      if (table === "stock_movements") return createMockQueryBuilder(null);
      if (table === "store_branches") return createMockQueryBuilder({ id: branchId });
      return createMockQueryBuilder(null);
    });

    const service = new StoreService(client);
    // `sendStockTransfer` calls `assertTransferStockAvailable`, which reads on-hand.
    jest.spyOn(service as any, "assertTransferStockAvailable").mockResolvedValue(undefined);
    // `getInventoryClient()` returns the admin client in production; force it
    // to the mock so the RPC assertion below hits this client (same as the
    // checkout tests do).
    (service as any).getInventoryClient = () => client;

    await service.sendStockTransfer(storeId, transferId, userId);

    expect(rpc).toHaveBeenCalledWith("decrement_product_stock", {
      p_product_id: productId,
      p_branch_id: branchId,
      p_quantity: 3,
      p_variant_id: variantId,
      p_reason: "transfer_out",
      p_reference_id: transferId,
      p_created_by: userId,
    });
  });
});