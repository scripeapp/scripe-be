/**
 * Tests for the page directory: manifest matching, URL resolution, and
 * the find_pages tool end-to-end with a mocked manifest fetch.
 */

jest.mock("../services/ai/page-registry.service", () => {
  const actual = jest.requireActual("../services/ai/page-registry.service");
  return { ...actual, fetchPageManifest: jest.fn() };
});

import {
  AgentPage,
  fetchPageManifest,
  matchPages,
  publicWebUrl,
  resolvePageUrl,
  tokenizePageQuery,
} from "../services/ai/page-registry.service";
import { buildFindPagesTool } from "../services/ai/tools/find-pages.tool";

const mockedFetchPageManifest = fetchPageManifest as jest.Mock;

const BUSINESS_SETTINGS_PAGE: AgentPage = {
  id: "settings.business",
  title: "Business Settings",
  description: "Business profile, branding, payouts and settlement, public info",
  aliases: [
    "business name",
    "change business name",
    "rename business",
    "business profile",
    "branding",
    "company name",
  ],
  path: "/dashboard?tab=settings&section=business",
};

const STORE_TAB_PAGE: AgentPage = {
  id: "dashboard.store",
  title: "Store",
  description: "Manage products, orders, and inventory",
  aliases: ["products", "orders", "inventory", "manage store"],
  path: "/dashboard?tab=store",
};

const PRODUCT_PAGE: AgentPage = {
  id: "store.product",
  title: "Product page",
  description: "A product's public store page",
  aliases: ["share product", "product link"],
  path: "/s/{storeSlug}/{productSlug}",
  entityParams: ["storeSlug", "productSlug"],
};

describe("tokenizePageQuery", () => {
  it("drops filler words and keeps meaningful terms", () => {
    expect(tokenizePageQuery("where can I change my business name")).toEqual([
      "change",
      "business",
      "name",
    ]);
  });
});

describe("matchPages", () => {
  const pages = [BUSINESS_SETTINGS_PAGE, STORE_TAB_PAGE, PRODUCT_PAGE];

  it("ranks the business settings page for a rename-business query", () => {
    const matches = matchPages(
      pages,
      "where can I change my business name",
      3,
    );
    expect(matches[0].id).toBe("settings.business");
  });

  it("ranks the store tab for product management queries", () => {
    const matches = matchPages(pages, "how do I manage my products", 3);
    expect(matches[0].id).toBe("dashboard.store");
  });

  it("returns an empty list when nothing matches", () => {
    expect(matchPages(pages, "random gibberish query", 3)).toEqual([]);
  });
});

describe("resolvePageUrl", () => {
  it("fills resolvable placeholders into the path", () => {
    expect(
      resolvePageUrl(PRODUCT_PAGE, {
        storeSlug: "hilaq-store",
        productSlug: "hoodie",
      }),
    ).toEqual({ url: publicWebUrl("/s/hilaq-store/hoodie"), needs: undefined });
  });

  it("reports missing params instead of building a guessed URL", () => {
    expect(resolvePageUrl(PRODUCT_PAGE, { storeSlug: "hilaq-store" })).toEqual({
      url: null,
      needs: ["productSlug"],
    });
  });
});

describe("buildFindPagesTool", () => {
  interface MockChain {
    select: jest.Mock;
    eq: jest.Mock;
    limit: jest.Mock;
    maybeSingle: jest.Mock;
  }

  function mockSupabase(routes: Record<string, { slug: string }>) {
    return {
      from: jest.fn((table: string) => {
        const row = routes[table] ?? null;
        const chain: MockChain = {
          select: jest.fn(() => chain),
          eq: jest.fn(() => chain),
          limit: jest.fn(() => chain),
          maybeSingle: jest.fn(async () => ({ data: row, error: null })),
        };
        return chain;
      }),
    } as never;
  }

  beforeEach(() => {
    mockedFetchPageManifest.mockReset();
  });

  it("resolves business-context slugs for a store search", async () => {
    mockedFetchPageManifest.mockResolvedValue([BUSINESS_SETTINGS_PAGE, STORE_TAB_PAGE, PRODUCT_PAGE]);
    const tool = buildFindPagesTool({
      businessId: "business-1",
      supabase: mockSupabase({ stores: { slug: "hilaq-store" } }),
    });

    const result = (await tool.execute({
      query: "where can I change my business name",
    })) as { pages: Array<{ id: string; url: string | null; needs?: string[] }> };

    expect(result.pages[0].id).toBe("settings.business");
    expect(result.pages[0].url).toBe(publicWebUrl("/dashboard?tab=settings&section=business"));
  });

  it("leaves entity-dependent pages unresolved with their needs", async () => {
    mockedFetchPageManifest.mockResolvedValue([PRODUCT_PAGE]);
    const tool = buildFindPagesTool({
      businessId: "business-1",
      supabase: mockSupabase({ stores: { slug: "hilaq-store" } }),
    });

    const result = (await tool.execute({
      query: "share my product page",
    })) as { pages: Array<{ id: string; url: string | null; needs?: string[] }> };

    expect(result.pages[0].id).toBe("store.product");
    expect(result.pages[0].url).toBeNull();
    expect(result.pages[0].needs).toEqual(["productSlug"]);
  });

  it("degrades gracefully when the manifest cannot be fetched", async () => {
    mockedFetchPageManifest.mockRejectedValue(new Error("network down"));
    const tool = buildFindPagesTool({
      businessId: "business-1",
      supabase: mockSupabase({}),
    });

    const result = (await tool.execute({ query: "anything" })) as {
      error: string;
    };
    expect(result.error).toContain("unavailable");
  });

  it("returns an empty page list when nothing matches", async () => {
    mockedFetchPageManifest.mockResolvedValue([STORE_TAB_PAGE]);
    const tool = buildFindPagesTool({
      businessId: "business-1",
      supabase: mockSupabase({}),
    });

    const result = (await tool.execute({ query: "zzz nothing here" })) as {
      pages: unknown[];
    };
    expect(result.pages).toEqual([]);
  });
});