import { SupabaseClient } from "@supabase/supabase-js";

export type CatalogItemKind = "product" | "event" | "course";

export interface CatalogCategory {
  id: string;
  name: string;
  slug: string;
}

/**
 * A single row in the unified store catalog. `kind` discriminates the source
 * table and drives how the frontend routes to the type-specific detail page.
 * Product-only fields (sku, stock, categories) are empty for events/courses.
 */
export interface CatalogItem {
  kind: CatalogItemKind;
  id: string;
  name: string;
  price: number | null;
  currency: string | null;
  cover_image: string | null;
  type: string;
  status: "published" | "draft";
  created_at: string;
  slug: string | null;
  sku: string | null;
  stock: number | null;
  orders_count: number;
  categories: CatalogCategory[];
}

export interface CatalogResult {
  data: CatalogItem[];
  meta: { total: number; page: number; limit: number; totalPages: number };
  facets: CatalogFacets;
}

export interface CatalogFacetOption {
  value: string;
  label: string;
  count: number;
}

export interface CatalogFacets {
  types: CatalogFacetOption[];
  categories: CatalogFacetOption[];
  availability: CatalogFacetOption[];
  suppliers: CatalogFacetOption[];
  creators: CatalogFacetOption[];
  channels: CatalogFacetOption[];
}

export type ProductAvailability =
  | "in_stock"
  | "low_stock"
  | "out_of_stock"
  | "unlimited";

export type ProductSalesChannel = "storefront" | "pos" | "marketplace";

export interface ListCatalogParams {
  storeId?: string;
  businessId?: string;
  page: number;
  limit: number;
  status?: "published" | "draft";
  search?: string;
  types?: string[];
  categoryIds?: string[];
  availability?: ProductAvailability[];
  priceMin?: number;
  priceMax?: number;
  createdFrom?: string;
  createdTo?: string;
  supplierIds?: string[];
  createdByIds?: string[];
  channels?: ProductSalesChannel[];
}

interface FetchWindow {
  status?: "published" | "draft";
  search?: string;
  types?: string[];
  categoryIds?: string[];
  availability?: ProductAvailability[];
  priceMin?: number;
  priceMax?: number;
  createdFrom?: string;
  createdTo?: string;
  supplierIds?: string[];
  createdByIds?: string[];
  channels?: ProductSalesChannel[];
  endIndex: number;
}

interface ProductCatalogRow {
  id: string;
  name: string;
  price: number | null;
  currency: string | null;
  type: string;
  status: "published" | "draft";
  cover_image: string | null;
  slug: string | null;
  stock: number | null;
  orders_count: number | null;
  created_at: string;
  is_sellable: boolean;
  created_by: string | null;
  storefront_enabled: boolean;
  pos_enabled: boolean;
  marketplace_enabled: boolean;
}

interface EventCatalogRow {
  id: string;
  event_name: string;
  status: "published" | "draft";
  cover_image: string | null;
  event_url: string | null;
  created_at: string;
}

interface CourseCatalogRow {
  id: string;
  title: string;
  price: number | string | null;
  payment_currency: string | null;
  cover_image_url: string | null;
  created_at: string;
}

interface ProductCategoryLink {
  product_id: string;
  category: CatalogCategory;
}

interface EventTicketRow {
  event_id: string;
  ticket_price: number | null;
  currency: string | null;
}

const MAX_PAGE = 1000;
const MAX_PAGE_SIZE = 50;

// Explicit, narrow column lists keep egress low (no `select("*")`).
const PRODUCT_CATALOG_COLUMNS = [
  "id",
  "store_id",
  "name",
  "price",
  "currency",
  "type",
  "status",
  "cover_image",
  "slug",
  "stock",
  "created_at",
  "is_sellable",
  "created_by",
  "storefront_enabled",
  "pos_enabled",
  "marketplace_enabled",
].join(", ");

const EVENT_CATALOG_COLUMNS = [
  "id",
  "event_name",
  "status",
  "cover_image",
  "event_url",
  "created_at",
].join(", ");

const COURSE_CATALOG_COLUMNS = [
  "id",
  "title",
  "price",
  "payment_currency",
  "cover_image_url",
  "created_at",
].join(", ");

export class CatalogService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Merge products, events, and courses into one list sorted by recency.
   * Each source is fetched through `endIndex` rows (bounded by the requested
   * page) then merged and sliced — one round-trip per source, one page back.
   */
  async listCatalog(params: ListCatalogParams): Promise<CatalogResult> {
    const page = Math.min(Math.max(params.page, 1), MAX_PAGE);
    const limit = Math.min(Math.max(params.limit, 1), MAX_PAGE_SIZE);
    const endIndex = page * limit;
    const {
      status,
      search,
      types,
      categoryIds,
      availability,
      priceMin,
      priceMax,
      createdFrom,
      createdTo,
      supplierIds,
      createdByIds,
      channels,
    } = params;
    const hasProductOnlyFilter = Boolean(
      categoryIds?.length ||
      availability?.length ||
      supplierIds?.length ||
      createdByIds?.length ||
      channels?.length,
    );

    const [products, events, courses] = await Promise.all([
      this.fetchProducts(params.storeId, { status, search, endIndex, types, categoryIds, availability, priceMin, priceMax, createdFrom, createdTo, supplierIds, createdByIds, channels }),
      hasProductOnlyFilter
        ? Promise.resolve({ items: [], total: 0 })
        : this.fetchEvents(params.businessId, { status, search, endIndex, types }),
      hasProductOnlyFilter
        ? Promise.resolve({ items: [], total: 0 })
        : this.fetchCourses(params.businessId, { status, search, endIndex, types }),
    ]);

    const facets = await this.buildFacets(params.storeId, {
      status, search, types, categoryIds, availability, priceMin, priceMax,
      createdFrom, createdTo, supplierIds, createdByIds, channels,
    }, events.total, courses.total);

    const merged = [...products.items, ...events.items, ...courses.items]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .slice((page - 1) * limit, endIndex);

    const total = products.total + events.total + courses.total;

    return {
      data: merged,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
      facets,
    };
  }

  private async buildFacets(
    storeId: string | undefined,
    window: Omit<FetchWindow, "endIndex">,
    eventTotal: number,
    courseTotal: number,
  ): Promise<CatalogFacets> {
    const empty: CatalogFacets = { types: [], categories: [], availability: [], suppliers: [], creators: [], channels: [] };
    if (!storeId) return empty;
    const { data, error } = await this.supabase.rpc("get_product_catalog_facets", {
      p_store_id: storeId,
      p_status: window.status ?? null,
      p_search: window.search ?? null,
      p_types: window.types?.length ? window.types : null,
      p_category_ids: window.categoryIds?.length ? window.categoryIds : null,
      p_availability: window.availability?.length ? window.availability : null,
      p_price_min: window.priceMin ?? null,
      p_price_max: window.priceMax ?? null,
      p_created_from: window.createdFrom ?? null,
      p_created_to: window.createdTo ?? null,
      p_supplier_ids: window.supplierIds?.length ? window.supplierIds : null,
      p_created_by_ids: window.createdByIds?.length ? window.createdByIds : null,
      p_channels: window.channels?.length ? window.channels : null,
    });
    if (error) throw error;
    const facets = { ...empty };
    for (const row of (data || []) as Array<{ facet: keyof CatalogFacets; value: string; label: string; count: number | string }>) {
      facets[row.facet].push({ value: row.value, label: row.label, count: Number(row.count) });
    }
    if (eventTotal) facets.types.push({ value: "event", label: "event", count: eventTotal });
    if (courseTotal) facets.types.push({ value: "course", label: "course", count: courseTotal });
    return facets;
  }

  private async fetchProducts(
    storeId: string | undefined,
    window: FetchWindow,
  ): Promise<{ items: CatalogItem[]; total: number }> {
    if (!storeId) return { items: [], total: 0 };

    const productIds = await this.findProductIdsForCategories(window.categoryIds);
    if (productIds?.length === 0) return { items: [], total: 0 };
    const supplierProductIds = await this.findProductIdsForSuppliers(storeId, window.supplierIds);
    if (supplierProductIds?.length === 0) return { items: [], total: 0 };

    let query = this.supabase
      .from("products")
      .select(PRODUCT_CATALOG_COLUMNS, { count: "exact" })
      .eq("store_id", storeId)
      .eq("is_sellable", true)
      .range(0, window.endIndex - 1)
      .order("created_at", { ascending: false });

    if (window.status) query = query.eq("status", window.status);
    if (window.search) query = query.ilike("name", `%${window.search}%`);
    if (window.types?.length) query = query.in("type", window.types);
    if (productIds?.length) query = query.in("id", productIds);
    if (window.priceMin !== undefined) query = query.gte("price", window.priceMin);
    if (window.priceMax !== undefined) query = query.lte("price", window.priceMax);
    if (window.createdFrom) query = query.gte("created_at", window.createdFrom);
    if (window.createdTo) query = query.lte("created_at", window.createdTo);
    if (supplierProductIds?.length) query = query.in("id", supplierProductIds);
    if (window.createdByIds?.length) query = query.in("created_by", window.createdByIds);
    if (window.channels?.length) {
      const channelFilters = window.channels.map(
        (channel) => `${channel}_enabled.eq.true`,
      );
      query = query.or(channelFilters.join(","));
    }
    if (window.availability?.length) {
      query = query.or(this.buildAvailabilityFilter(window.availability));
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = (data as unknown as ProductCatalogRow[]) || [];
    const rowIds = rows.map((row) => row.id);
    const [categoriesByProduct, variantStockByProduct] = await Promise.all([
      this.fetchProductCategories(rowIds),
      this.fetchProductVariantStock(rowIds),
    ]);

    return {
      items: rows.map((row) => ({
        kind: "product" as const,
        id: row.id,
        name: row.name,
        price: row.price ?? null,
        currency: row.currency ?? null,
        cover_image: row.cover_image ?? null,
        type: row.type,
        status: row.status,
        created_at: row.created_at,
        slug: row.slug ?? null,
        // No product-level sku column exists — sku only lives on
        // product_variants (20260101_add_product_subtypes.sql), same
        // ambiguity as stock but left as-is here since fixing it needs the
        // same aggregation treatment and wasn't part of what broke.
        sku: null,
        stock: this.resolveCatalogStock(row.stock, variantStockByProduct[row.id]),
        orders_count: 0,
        categories: categoriesByProduct[row.id] ?? [],
      })),
      total: count || 0,
    };
  }

  private async findProductIdsForCategories(
    categoryIds: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (!categoryIds?.length) return undefined;

    const { data, error } = await this.supabase
      .from("product_categories")
      .select("product_id")
      .in("category_id", categoryIds);
    if (error) throw error;

    return [...new Set((data || []).map((row) => row.product_id))];
  }

  private async findProductIdsForSuppliers(
    storeId: string,
    supplierIds: string[] | undefined,
  ): Promise<string[] | undefined> {
    if (!supplierIds?.length) return undefined;
    const { data, error } = await this.supabase
      .from("supplier_products")
      .select("product_id")
      .eq("store_id", storeId)
      .eq("status", "active")
      .in("supplier_id", supplierIds);
    if (error) throw error;
    return [...new Set((data ?? []).map((row) => row.product_id))];
  }

  private buildAvailabilityFilter(availability: ProductAvailability[]): string {
    const clauses = availability.map((value) => {
      switch (value) {
        case "in_stock":
          return "stock.gt.10";
        case "low_stock":
          return "and(stock.gt.0,stock.lte.10)";
        case "out_of_stock":
          return "stock.eq.0";
        case "unlimited":
          return "stock.is.null,stock.eq.-1";
      }
    });

    return clauses.join(",");
  }

  /**
   * A variant-based product's own `stock` column is always null (real
   * inventory lives on each product_variants row instead) — read on its own
   * this silently reported every variant-tracked product as "unlimited" in
   * the catalog list. Batched per page like fetchProductCategories.
   */
  private async fetchProductVariantStock(
    productIds: string[],
  ): Promise<Record<string, Array<number | null>>> {
    if (productIds.length === 0) return {};

    const { data } = await this.supabase
      .from("product_variants")
      .select("product_id, stock")
      .in("product_id", productIds);

    const stockByProduct: Record<string, Array<number | null>> = {};
    ((data as { product_id: string; stock: number | null }[]) || []).forEach(
      (row) => {
        if (!stockByProduct[row.product_id]) {
          stockByProduct[row.product_id] = [];
        }
        stockByProduct[row.product_id].push(row.stock);
      },
    );
    return stockByProduct;
  }

  /**
   * Prefers summing tracked variant stock when the product has variants
   * (untracked variants — stock: null — don't contribute, but don't zero
   * out the total either); falls back to the product's own `stock` column
   * for products without variants.
   */
  private resolveCatalogStock(
    productStock: number | null,
    variantStocks: Array<number | null> | undefined,
  ): number | null {
    if (!variantStocks || variantStocks.length === 0) return productStock;
    const tracked = variantStocks.filter(
      (stock): stock is number => stock !== null,
    );
    if (tracked.length === 0) return null;
    return tracked.reduce((sum, stock) => sum + stock, 0);
  }

  private async fetchProductCategories(
    productIds: string[],
  ): Promise<Record<string, CatalogCategory[]>> {
    if (productIds.length === 0) return {};

    const { data } = await this.supabase
      .from("product_categories")
      .select("product_id, category:store_categories(id, name, slug)")
      .in("product_id", productIds);

    const categoriesByProduct: Record<string, CatalogCategory[]> = {};
    ((data as unknown as ProductCategoryLink[]) || []).forEach((link) => {
      if (!categoriesByProduct[link.product_id]) {
        categoriesByProduct[link.product_id] = [];
      }
      categoriesByProduct[link.product_id].push(link.category);
    });
    return categoriesByProduct;
  }

  private async fetchEvents(
    businessId: string | undefined,
    window: FetchWindow,
  ): Promise<{ items: CatalogItem[]; total: number }> {
    if (!businessId) return { items: [], total: 0 };
    if (window.types?.length && !window.types.includes("event")) {
      return { items: [], total: 0 };
    }

    let query = this.supabase
      .from("events")
      .select(EVENT_CATALOG_COLUMNS, { count: "exact" })
      .eq("business_id", businessId)
      .range(0, window.endIndex - 1)
      .order("created_at", { ascending: false });

    if (window.status) query = query.eq("status", window.status);
    if (window.search) query = query.ilike("event_name", `%${window.search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = (data as unknown as EventCatalogRow[]) || [];
    const pricesByEvent = await this.fetchEventMinPrices(
      rows.map((row) => row.id),
    );

    return {
      items: rows.map((row) => {
        const price = pricesByEvent[row.id];
        return {
          kind: "event" as const,
          id: row.id,
          name: row.event_name,
          price: price?.amount ?? null,
          currency: price?.currency ?? "NGN",
          cover_image: row.cover_image ?? null,
          type: "event",
          status: row.status,
          created_at: row.created_at,
          slug: row.event_url ?? null,
          sku: null,
          stock: null,
          orders_count: 0,
          categories: [],
        };
      }),
      total: count || 0,
    };
  }

  private async fetchEventMinPrices(
    eventIds: string[],
  ): Promise<Record<string, { amount: number; currency: string }>> {
    if (eventIds.length === 0) return {};

    const { data } = await this.supabase
      .from("event_tickets")
      .select("event_id, ticket_price, currency")
      .in("event_id", eventIds);

    const minPriceByEvent: Record<string, { amount: number; currency: string }> =
      {};
    ((data as EventTicketRow[]) || []).forEach((ticket) => {
      const amount = Number(ticket.ticket_price) || 0;
      const current = minPriceByEvent[ticket.event_id];
      if (!current || amount < current.amount) {
        minPriceByEvent[ticket.event_id] = {
          amount,
          currency: ticket.currency || "NGN",
        };
      }
    });
    return minPriceByEvent;
  }

  private async fetchCourses(
    businessId: string | undefined,
    window: FetchWindow,
  ): Promise<{ items: CatalogItem[]; total: number }> {
    if (!businessId) return { items: [], total: 0 };
    if (window.status === "draft") return { items: [], total: 0 };
    if (window.types?.length && !window.types.includes("course")) {
      return { items: [], total: 0 };
    }

    let query = this.supabase
      .from("courses")
      .select(COURSE_CATALOG_COLUMNS, { count: "exact" })
      .eq("business_id", businessId)
      .range(0, window.endIndex - 1)
      .order("created_at", { ascending: false });

    if (window.search) query = query.ilike("title", `%${window.search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    const rows = (data as unknown as CourseCatalogRow[]) || [];

    return {
      items: rows.map((row) => ({
        kind: "course" as const,
        id: row.id,
        name: row.title,
        price: row.price == null ? null : Number(row.price),
        currency: row.payment_currency ?? "NGN",
        cover_image: row.cover_image_url ?? null,
        type: "course",
        status: "published",
        created_at: row.created_at,
        slug: null,
        sku: null,
        stock: null,
        orders_count: 0,
        categories: [],
      })),
      total: count || 0,
    };
  }
}
