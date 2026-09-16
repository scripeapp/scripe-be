/**
 * Tests for the read-only Q&A tools — focused on list_products,
 * the catalog listing added for "how many products / list products"
 * questions the agent previously could not answer.
 */

import { buildQaTools } from "../services/ai/tools/qa.tools";
import { AITool } from "../services/ai/ai-provider.types";

interface ProductRow {
  id: string;
  name: string;
  price: number;
  currency: string | null;
  stock: number | null;
  status: string;
  store_id: string;
}

type ListProductsTool = AITool<
  { query?: string; limit?: number },
  unknown
>;

function listProductsTool(supabase: never): ListProductsTool {
  const tools = buildQaTools({
    userId: "u1",
    businessId: "b1",
    supabase,
  });
  return tools.find(
    (t) => t.name === "list_products",
  ) as ListProductsTool;
}

function makeChain(result: unknown, isHeadSelect = false) {
  const chain = {
    isHead: isHeadSelect,
    select: jest.fn(function (
      this: { isHead: boolean },
      _cols: string,
      opts?: { head?: boolean },
    ) {
      this.isHead = Boolean(opts?.head);
      return this;
    }),
    in: jest.fn(function (this: unknown) {
      return this;
    }),
    ilike: jest.fn(function (this: unknown) {
      return this;
    }),
    order: jest.fn(function (this: unknown) {
      return this;
    }),
    limit: jest.fn(function (this: unknown) {
      return this;
    }),
    eq: jest.fn(function (this: unknown) {
      return this;
    }),
    then: jest.fn(function (
      this: { isHead: boolean },
      resolve: (value: unknown) => void,
    ) {
      if (this.isHead) return resolve({ count: result, error: null });
      return resolve({ data: result, error: null });
    }),
  };
  return chain;
}

function mockSupabase(options: {
  stores: Array<{ id: string; name: string }>;
  count: number;
  products: ProductRow[];
}) {
  const { stores, count, products } = options;
  const productsChain = makeChain(products);
  productsChain.then = jest.fn(function (
    this: { isHead: boolean },
    resolve: (value: unknown) => void,
  ) {
    if (this.isHead) return resolve({ count, error: null });
    return resolve({ data: products, error: null });
  });
  return {
    from: jest.fn((table: string) =>
      table === "stores" ? makeChain(stores) : productsChain,
    ),
  } as never;
}

describe("list_products", () => {
  const products: ProductRow[] = [
    {
      id: "p1",
      name: "Hoodie",
      price: 25000,
      currency: null,
      stock: 5,
      status: "published",
      store_id: "s1",
    },
    {
      id: "p2",
      name: "Cap",
      price: 12000,
      currency: "NGN",
      stock: null,
      status: "draft",
      store_id: "s2",
    },
  ];

  it("returns the exact catalog count and a mapped product list", async () => {
    const supabase = mockSupabase({
      stores: [
        { id: "s1", name: "Clothing" },
        { id: "s2", name: "Accessories" },
      ],
      count: 2,
      products,
    });
    const listProducts = await listProductsTool(supabase);

    const result = (await listProducts.execute({ limit: 20 })) as {
      total: number;
      products: Array<{ id: string; store: string; currency: string }>;
    };

    expect(result.total).toBe(2);
    expect(result.products).toHaveLength(2);
    expect(result.products[0]).toMatchObject({
      id: "p1",
      store: "Clothing",
      currency: "NGN",
    });
    expect(result.products[1].store).toBe("Accessories");
  });

  it("passes the name search to the count and list queries", async () => {
    const supabase = mockSupabase({
      stores: [{ id: "s1", name: "Clothing" }],
      count: 1,
      products: [products[0]],
    });
    const listProducts = listProductsTool(supabase);

    await listProducts.execute({ query: "hoodie" });

    const productsChain = (supabase as never as {
      from: jest.Mock;
    }).from.mock.results[1].value;
    expect(productsChain.ilike).toHaveBeenCalledWith("name", "%hoodie%");
    expect(productsChain.ilike).toHaveBeenCalledTimes(2);
  });

  it("returns an empty catalog when the business has no stores", async () => {
    const listProducts = listProductsTool(
      mockSupabase({ stores: [], count: 0, products: [] }),
    );

    expect(await listProducts.execute({})).toEqual({ total: 0, products: [] });
  });
});