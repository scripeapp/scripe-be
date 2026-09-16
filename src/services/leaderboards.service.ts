import { SupabaseClient } from "@supabase/supabase-js";

export class LeaderboardsService {
  /**
   * Top businesses by revenue (from transactions)
   */
  async getTopByRevenue(
    supabase: SupabaseClient,
    params: { limit?: number; from?: string; to?: string } = {},
  ) {
    const limit = params.limit || 20;

    let query = supabase
      .from("transactions")
      .select("business_id, amount, status")
      .eq("status", "success");

    if (params.from) query = query.gte("created_at", params.from);
    if (params.to) query = query.lte("created_at", params.to);

    const { data: txs } = await query;

    if (!txs || txs.length === 0) return [];

    // Aggregate
    const revenueMap: Record<string, number> = {};
    txs.forEach((t) => {
      if (t.business_id) {
        revenueMap[t.business_id] = (revenueMap[t.business_id] || 0) + (t.amount || 0);
      }
    });

    // Sort and take top N
    const sorted = Object.entries(revenueMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit);

    // Enrich with business info
    const ids = sorted.map(([id]) => id);
    const { data: businesses } = await supabase
      .from("businesses")
      .select("id, name, email, subscription_plan")
      .in("id", ids);

    const bizMap = Object.fromEntries((businesses || []).map((b) => [b.id, b]));

    return sorted.map(([id, revenue]) => ({
      business_id: id,
      revenue,
      ...(bizMap[id] || { name: "Unknown", email: "", subscription_plan: "unknown" }),
    }));
  }

  /**
   * Top businesses by number of orders
   */
  async getTopByOrders(
    supabase: SupabaseClient,
    params: { limit?: number; from?: string; to?: string } = {},
  ) {
    const limit = params.limit || 20;

    let query = supabase
      .from("orders")
      .select("business_id");

    if (params.from) query = query.gte("created_at", params.from);
    if (params.to) query = query.lte("created_at", params.to);

    const { data: orders } = await query;

    if (!orders || orders.length === 0) return [];

    const countMap: Record<string, number> = {};
    orders.forEach((o) => {
      if (o.business_id) {
        countMap[o.business_id] = (countMap[o.business_id] || 0) + 1;
      }
    });

    const sorted = Object.entries(countMap)
      .sort(([, a], [, b]) => b - a)
      .slice(0, limit);

    const ids = sorted.map(([id]) => id);
    const { data: businesses } = await supabase
      .from("businesses")
      .select("id, name, email, subscription_plan")
      .in("id", ids);

    const bizMap = Object.fromEntries((businesses || []).map((b) => [b.id, b]));

    return sorted.map(([id, order_count]) => ({
      business_id: id,
      order_count,
      ...(bizMap[id] || { name: "Unknown", email: "", subscription_plan: "unknown" }),
    }));
  }

  /**
   * Most recently active businesses
   */
  async getMostActive(
    supabase: SupabaseClient,
    limit = 20,
  ) {
    const { data, error } = await supabase
      .from("businesses")
      .select("id, name, email, subscription_plan, last_login_at, created_at")
      .eq("subscription_status", "active")
      .not("last_login_at", "is", null)
      .order("last_login_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    return data || [];
  }

  /**
   * Fastest growing businesses (newest to hit revenue milestones)
   */
  async getNewestPaidBusinesses(
    supabase: SupabaseClient,
    limit = 20,
  ) {
    const { data, error } = await supabase
      .from("businesses")
      .select("id, name, email, subscription_plan, created_at")
      .in("subscription_plan", ["plus", "pro"])
      .eq("subscription_status", "active")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    return data || [];
  }
}

export const leaderboardsService = new LeaderboardsService();
