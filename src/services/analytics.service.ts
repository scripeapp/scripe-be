import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabase";

export interface AnalyticsEventInput {
  event_type:
    | "page_view"
    | "product_view"
    | "add_to_cart"
    | "initiate_checkout"
    | "purchase";
  resource_id?: string;
  resource_type?: "product" | "store" | "event";
  store_id?: string;
  business_id?: string;
  session_id?: string;
  user_id?: string;
  metadata?: Record<string, any>;
}

export class AnalyticsService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Track a user event
   */
  async trackEvent(input: AnalyticsEventInput): Promise<void> {
    try {
      // Debouncing: Skip if same event from same session/resource in last 5 mins
      // Exempt high-value events like purchase
      if (!["purchase", "add_to_cart"].includes(input.event_type)) {
        const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

        let query = this.supabase
          .from("analytics_events")
          .select("id")
          .eq("event_type", input.event_type)
          .eq("session_id", input.session_id)
          .gte("created_at", fiveMinsAgo)
          .limit(1);

        if (input.resource_id)
          query = query.eq("resource_id", input.resource_id);
        if (input.store_id) query = query.eq("store_id", input.store_id);

        const { data: existing } = await query;
        if (existing && existing.length > 0) {
          return; // Skip duplicate noise
        }
      }

      // Use admin client for write to bypass potential RLS issues with public tracking
      const { error } = await supabaseAdmin
        .from("analytics_events")
        .insert([input]);

      if (error) {
        console.error("Failed to track analytics event:", error);
      }
    } catch (err) {
      console.error("Error tracking analytics event:", err);
    }
  }

  /**
   * Get store overview for dashboard
   */
  async getStoreOverview(
    storeId: string,
    range: "7d" | "30d" | "all" = "30d",
  ): Promise<{
    total_revenue: number;
    total_orders: number;
    total_customers: number;
    total_views: number;
    conversion_rate: number;
    sales_chart: { date: string; value: number }[];
    views_chart: { date: string; value: number }[];
  }> {
    // Determine date range filter
    let startDate: string | undefined;
    const now = new Date();

    if (range === "7d") {
      startDate = new Date(now.setDate(now.getDate() - 7)).toISOString();
    } else if (range === "30d") {
      startDate = new Date(now.setDate(now.getDate() - 30)).toISOString();
    }

    // 1. Fetch Orders (Revenue, Orders, Customers)
    let orderQuery = this.supabase
      .from("store_orders")
      .select("id, total, created_at, customer_email")
      .eq("store_id", storeId)
      .in("status", ["paid", "fulfilled"]);

    if (startDate) {
      orderQuery = orderQuery.gte("created_at", startDate);
    }

    const { data: orders } = await orderQuery;

    const total_revenue = (orders || []).reduce(
      (sum, o) => sum + Number(o.total || 0),
      0,
    );
    const total_orders = (orders || []).length;
    const uniqueEmails = new Set((orders || []).map((o) => o.customer_email));
    const total_customers = uniqueEmails.size;

    // 2. Fetch Views (from analytics_events)
    let viewsQuery = this.supabase
      .from("analytics_events")
      .select("created_at", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("event_type", "store_view"); // or page_view depending on what we track

    if (startDate) {
      viewsQuery = viewsQuery.gte("created_at", startDate);
    }

    const { count: viewCount } = await viewsQuery;
    const total_views = viewCount || 0;

    // 3. Calculate Conversion Rate
    const conversion_rate =
      total_views > 0 ? (total_orders / total_views) * 100 : 0;

    // 4. Generate Chart Data
    // Note: Doing simple client-side aggregation for now as SQL grouping requires RPC
    const salesChart = this.aggregateByDate(orders || [], "total");

    // For views chart, we need to fetch data since we only got count above
    let viewsDataQuery = this.supabase
      .from("analytics_events")
      .select("created_at")
      .eq("store_id", storeId)
      .eq("event_type", "store_view");

    if (startDate) {
      viewsDataQuery = viewsDataQuery.gte("created_at", startDate);
    }
    const { data: viewsData } = await viewsDataQuery;
    const viewsChart = this.aggregateByDate(viewsData || [], null); // count occurrences

    return {
      total_revenue,
      total_orders,
      total_customers,
      total_views,
      conversion_rate: Math.round(conversion_rate * 100) / 100,
      sales_chart: salesChart,
      views_chart: viewsChart,
    };
  }

  private aggregateByDate(
    data: any[],
    valueKey: string | null,
  ): { date: string; value: number }[] {
    const grouped: Record<string, number> = {};

    data.forEach((item) => {
      const date = new Date(item.created_at).toISOString().split("T")[0]; // YYYY-MM-DD
      const value = valueKey ? Number(item[valueKey] || 0) : 1;
      grouped[date] = (grouped[date] || 0) + value;
    });

    return Object.entries(grouped)
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Aggregated POS overview for the store tab's Point of Sale sub-tab:
   * register/session counts plus last-30-days sales analytics. A single
   * request keeps the dashboard's egress low — the orders query returns
   * only the columns needed to compute every figure here.
   */
  async getPosOverview(
    storeId: string,
    businessId?: string,
    range: "7d" | "30d" | "all" = "30d",
  ): Promise<{
    registers_count: number;
    sessions_count: number;
    gross_sales: number;
    orders_count: number;
    discounts_total: number;
    returns_total: number;
    sales_chart: { date: string; value: number }[];
    registers: {
      id: string;
      name: string;
      branch_id: string | null;
      branch_name: string | null;
      device_type: string | null;
      paired_at: string | null;
      status: "active" | "inactive";
      register_version: string | null;
      last_active_at: string | null;
    }[];
    sessions: {
      register_id: string;
      register_name: string;
      opened_at: string;
      starting_float: number;
      staff_name: string | null;
    }[];
  }> {
    if (businessId) {
      const { data: store, error: storeError } = await this.supabase
        .from("stores")
        .select("id")
        .eq("id", storeId)
        .eq("business_id", businessId)
        .single();

      if (storeError || !store) {
        throw Object.assign(new Error("Store not found or access denied"), {
          statusCode: 404,
        });
      }
    }

    let startDate: string | undefined;
    const now = new Date();
    if (range === "7d") {
      startDate = new Date(now.setDate(now.getDate() - 7)).toISOString();
    } else if (range === "30d") {
      startDate = new Date(now.setDate(now.getDate() - 30)).toISOString();
    }

    const { count: registersCount, error: registersError } =
      await this.supabase
        .from("registers")
        .select("id", { count: "exact", head: true })
        .eq("store_id", storeId);
    if (registersError) throw registersError;

    const { data: registerRows, error: registersListError } =
      await this.supabase
        .from("registers")
        .select(
          `id, name, device_type, paired_at, status, branch_id, register_version,
           branch:store_branches(id, name),
           last_shift:register_shifts(register_id, opened_at)`,
        )
        .eq("store_id", storeId)
        // PostgREST aggregates are disabled on this project, so "latest shift
        // per register" is done with a per-row lateral join instead: order the
        // embedded register_shifts desc and cap it at one row per register.
        .order("opened_at", {
          foreignTable: "register_shifts",
          ascending: false,
        })
        .limit(1, { foreignTable: "register_shifts" })
        .order("created_at", { ascending: true });
    if (registersListError) throw registersListError;

    const registerIds = (registerRows || []).map(
      (register: { id: string }) => register.id,
    );
    let openShifts: {
      register_id: string;
      opened_at: string;
      starting_float: number;
      opened_by: string | null;
      opened_by_staff_id: string | null;
    }[] = [];
    if (registerIds.length > 0) {
      const { data: shifts, error: shiftsError } = await this.supabase
        .from("register_shifts")
        .select(
          "register_id, opened_at, starting_float, opened_by, opened_by_staff_id",
        )
        .in("register_id", registerIds)
        .eq("status", "open");
      if (shiftsError) throw shiftsError;
      openShifts = shifts || [];
    }

    // A shift can be opened either by a dashboard user (opened_by) or a
    // till-PIN staffer (opened_by_staff_id) — prefer the staffer's real
    // name when one identified themselves, since that's who's actually
    // running the till, not just whoever's device/session it is.
    const staffIds = Array.from(
      new Set(
        openShifts.map((s) => s.opened_by_staff_id).filter((id): id is string => !!id),
      ),
    );
    const staffNameById = new Map<string, string>();
    if (staffIds.length > 0) {
      const { data: staff, error: staffError } = await this.supabase
        .from("pos_staff")
        .select("id, name")
        .in("id", staffIds);
      if (staffError) throw staffError;
      (staff || []).forEach((s: { id: string; name: string | null }) => {
        if (s.name) staffNameById.set(s.id, s.name);
      });
    }

    // register_shifts.opened_by references auth.users, which isn't
    // embeddable via PostgREST relationship syntax (not in the exposed
    // schema) — resolved instead through the public `profiles` table, the
    // same pattern campaign-credits.service.ts already uses for this.
    const openerIds = Array.from(
      new Set(openShifts.map((s) => s.opened_by).filter((id): id is string => !!id)),
    );
    const openerEmailById = new Map<string, string>();
    if (openerIds.length > 0) {
      const { data: profiles, error: profilesError } = await this.supabase
        .from("profiles")
        .select("user_id, email")
        .in("user_id", openerIds);
      if (profilesError) throw profilesError;
      (profiles || []).forEach((p: { user_id: string; email: string | null }) => {
        if (p.email) openerEmailById.set(p.user_id, p.email);
      });
    }

    let orderQuery = this.supabase
      .from("store_orders")
      .select("id, total, discount, status, created_at")
      .eq("store_id", storeId)
      .in("status", ["paid", "fulfilled", "refunded"]);
    if (startDate) {
      orderQuery = orderQuery.gte("created_at", startDate);
    }

    const { data: orders, error: ordersError } = await orderQuery;
    if (ordersError) throw ordersError;

    const paidOrders = (orders || []).filter((order) =>
      ["paid", "fulfilled"].includes(order.status),
    );
    const gross_sales = paidOrders.reduce(
      (sum, order) => sum + Number(order.total || 0),
      0,
    );
    const discounts_total = paidOrders.reduce(
      (sum, order) => sum + Number(order.discount || 0),
      0,
    );
    const returns_total = (orders || [])
      .filter((order) => order.status === "refunded")
      .reduce((sum, order) => sum + Number(order.total || 0), 0);

    return {
      registers_count: registersCount || 0,
      sessions_count: openShifts.length,
      gross_sales,
      orders_count: paidOrders.length,
      discounts_total,
      returns_total,
      sales_chart: this.aggregateByDate(paidOrders, "total"),
      registers: (registerRows || []).map((register: any) => ({
        id: register.id,
        name: register.name,
        branch_id: register.branch_id ?? null,
        branch_name: register.branch?.name ?? null,
        device_type: register.device_type ?? null,
        paired_at: register.paired_at ?? null,
        status: register.status,
        register_version: register.register_version ?? null,
        last_active_at: register.last_shift?.[0]?.opened_at ?? null,
      })),
      sessions: openShifts.map((shift) => {
        const staffName = shift.opened_by_staff_id
          ? staffNameById.get(shift.opened_by_staff_id)
          : undefined;
        const openerEmail = shift.opened_by
          ? openerEmailById.get(shift.opened_by)
          : undefined;
        return {
          register_id: shift.register_id,
          register_name:
            (registerRows || []).find(
              (register: any) => register.id === shift.register_id,
            )?.name ?? "Unknown register",
          opened_at: shift.opened_at,
          starting_float: shift.starting_float,
          staff_name: staffName ?? openerEmail?.split("@")[0] ?? null,
        };
      }),
    };
  }

  async getStoreEvents(
    storeId: string,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ events: any[]; total: number }> {    const offset = (page - 1) * limit;

    const { data, error, count } = await this.supabase
      .from("analytics_events")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    return {
      events: data || [],
      total: count || 0,
    };
  }
}
