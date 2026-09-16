/**
 * Read-only Q&A tools for the dashboard agent. Each tool closes over the
 * authenticated user/business/supabase — the model never supplies IDs.
 * Queries mirror what the dashboard home already fetches
 * (see getDashboardStats in eventsMgr.controller.ts).
 */
import { z } from "zod";
import { SupabaseClient } from "@supabase/supabase-js";
import { AITool } from "../ai-provider.types";

interface QaToolsContext {
  userId: string;
  businessId: string;
  supabase: SupabaseClient;
}

const PERIOD_DAYS: Record<string, number | null> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: null,
};

function periodStart(period: string): string | null {
  const days = PERIOD_DAYS[period] ?? 30;
  if (days === null) return null;
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export function buildQaTools(ctx: QaToolsContext): AITool[] {
  const { businessId, supabase } = ctx;

  const listStores: AITool = {
    name: "list_stores",
    description:
      "List the merchant's stores with name, slug, sells_in_person flag and live status.",
    parameters: z.object({}),
    execute: async () => {
      const { data, error } = await supabase
        .from("stores")
        .select("id, name, slug, sells_in_person, is_live, created_at")
        .eq("business_id", businessId)
        .order("created_at", { ascending: false });
      if (error) return { error: error.message };
      return { stores: data ?? [] };
    },
  };

  const getDashboardStats: AITool = {
    name: "get_dashboard_stats",
    description:
      "Total revenue for the business over a period, broken down by source (store, events, publications, circles, scheduling), plus paid-order count. Use for any 'how much did I make / how are sales' question.",
    parameters: z.object({
      period: z
        .enum(["7d", "30d", "90d", "all"])
        .describe("Time window to aggregate over")
        .default("30d"),
    }),
    execute: async ({ period }: { period: string }) => {
      let query = supabase
        .from("business_revenue_ledger_view")
        .select("amount, source, created_at")
        .eq("business_id", businessId)
        .eq("status", "paid");
      const start = periodStart(period);
      if (start) query = query.gte("created_at", start);
      const { data, error } = await query;
      if (error) return { error: error.message };

      const breakdown: Record<string, number> = {};
      for (const row of data ?? []) {
        const source = row.source || "other";
        breakdown[source] =
          (breakdown[source] || 0) + (Number(row.amount) || 0);
      }
      const total = Object.values(breakdown).reduce((s, v) => s + v, 0);
      return {
        period,
        currency: "NGN",
        total_revenue: total,
        revenue_by_source: breakdown,
        paid_entries: (data ?? []).length,
      };
    },
  };

  const getRecentOrders: AITool = {
    name: "get_recent_orders",
    description:
      "Most recent store orders across all the merchant's stores: order number, customer, total, status, date.",
    parameters: z.object({
      limit: z.number().int().min(1).max(20).default(5),
    }),
    execute: async ({ limit }: { limit: number }) => {
      const { data: stores, error: storesError } = await supabase
        .from("stores")
        .select("id, name")
        .eq("business_id", businessId);
      if (storesError) return { error: storesError.message };
      if (!stores?.length) return { orders: [] };

      const storeNames = new Map(stores.map((s) => [s.id, s.name]));
      const { data, error } = await supabase
        .from("store_orders")
        .select(
          "order_number, customer_name, total, currency, status, created_at, store_id",
        )
        .in("store_id", [...storeNames.keys()])
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) return { error: error.message };

      return {
        orders: (data ?? []).map((o) => ({
          order_number: o.order_number,
          customer_name: o.customer_name,
          total: o.total,
          currency: o.currency || "NGN",
          status: o.status,
          store: storeNames.get(o.store_id) || "Unknown store",
          created_at: o.created_at,
        })),
      };
    },
  };

  const getTopProducts: AITool = {
    name: "get_top_products",
    description:
      "Best-selling products across the merchant's stores by units sold in paid/fulfilled orders over a period.",
    parameters: z.object({
      period: z.enum(["7d", "30d", "90d", "all"]).default("30d"),
      limit: z.number().int().min(1).max(10).default(5),
    }),
    execute: async ({ period, limit }: { period: string; limit: number }) => {
      const { data: stores, error: storesError } = await supabase
        .from("stores")
        .select("id")
        .eq("business_id", businessId);
      if (storesError) return { error: storesError.message };
      if (!stores?.length) return { products: [] };

      const storeIds = stores.map((s) => s.id);
      let ordersQuery = supabase
        .from("store_orders")
        .select("items, created_at")
        .in("store_id", storeIds)
        .in("status", ["paid", "fulfilled"]);
      const start = periodStart(period);
      if (start) ordersQuery = ordersQuery.gte("created_at", start);
      const { data: orders, error } = await ordersQuery;
      if (error) return { error: error.message };

      const soldCounts: Record<string, { name: string; sold: number }> = {};
      for (const order of orders ?? []) {
        const items = order.items as Array<{
          product_id?: string;
          product_name?: string;
          name?: string;
          quantity?: number;
        }>;
        if (!Array.isArray(items)) continue;
        for (const item of items) {
          if (!item.product_id) continue;
          const entry = (soldCounts[item.product_id] ??= {
            name: item.product_name || item.name || "Product",
            sold: 0,
          });
          entry.sold += item.quantity || 1;
        }
      }

      const products = Object.values(soldCounts)
        .sort((a, b) => b.sold - a.sold)
        .slice(0, limit);
      return { period, products };
    },
  };

  const listProducts: AITool = {
    name: "list_products",
    description:
      "List the merchant's products across all their stores with name, price, stock, status and store, plus the exact total catalog count. Use for any 'how many products do I have', 'list/show my products', or catalog questions. Optionally narrow by a name search.",
    parameters: z.object({
      query: z
        .string()
        .max(120)
        .describe("Optional product name search term")
        .optional(),
      limit: z.number().int().min(1).max(100).default(20),
    }),
    execute: async ({ query, limit }: { query?: string; limit: number }) => {
      const { data: stores, error: storesError } = await supabase
        .from("stores")
        .select("id, name")
        .eq("business_id", businessId);
      if (storesError) return { error: storesError.message };
      if (!stores?.length) return { total: 0, products: [] };

      const storeIds = stores.map((s) => s.id);
      const storeNames = new Map(stores.map((s) => [s.id, s.name]));

      let countQuery = supabase
        .from("products")
        .select("id", { count: "exact", head: true })
        .in("store_id", storeIds);
      if (query?.trim()) countQuery = countQuery.ilike("name", `%${query.trim()}%`);
      const { count, error: countError } = await countQuery;
      if (countError) return { error: countError.message };

      let listQuery = supabase
        .from("products")
        .select("id, name, price, currency, stock, status, store_id")
        .in("store_id", storeIds)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (query?.trim()) listQuery = listQuery.ilike("name", `%${query.trim()}%`);
      const { data, error } = await listQuery;
      if (error) return { error: error.message };

      return {
        total: count ?? 0,
        products: (data ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          currency: p.currency || "NGN",
          stock: p.stock,
          status: p.status,
          store: storeNames.get(p.store_id) || "Unknown store",
        })),
      };
    },
  };

  return [listStores, getDashboardStats, getRecentOrders, getTopProducts, listProducts];
}
