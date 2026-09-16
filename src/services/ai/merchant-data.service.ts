import { SupabaseClient } from "@supabase/supabase-js";
import { MerchantCapabilityId } from "./merchant-capabilities";

export type MerchantPeriod = "7d" | "30d" | "90d" | "all";

interface StoreRow {
  id: string;
  name: string;
  slug: string;
  is_live: boolean;
  sells_in_person: boolean | null;
  created_at: string;
}

interface ProductRow {
  id: string;
  store_id: string;
  name: string;
  description: string | null;
  price: number;
  compare_at_price: number | null;
  currency: string | null;
  type: string;
  status: string;
  cover_image: string | null;
  images: string[] | null;
  stock: number | null;
  orders_count: number | null;
  digital: Record<string, unknown> | null;
  updated_at: string;
}

interface OrderItem {
  product_id?: string;
  product_name?: string;
  name?: string;
  quantity?: number;
  price?: number;
}

interface OrderRow {
  id: string;
  store_id: string;
  order_number: string;
  customer_name: string;
  customer_email: string;
  items: OrderItem[];
  subtotal: number;
  discount: number;
  total: number;
  currency: string | null;
  status: string;
  shipping_status: string | null;
  created_at: string;
}

interface CustomerRow {
  id: string;
  store_id: string;
  name: string;
  email: string;
  orders_count: number;
  lifetime_value: number;
  first_order_at: string;
  last_order_at: string;
}

interface EventRow {
  id: string;
  event_name: string;
  status: string;
  event_type: string | null;
  start_date: string | null;
  end_date: string | null;
  venue: string | null;
  is_online: boolean | null;
  is_physical: boolean | null;
}

interface BookingRow {
  id: string;
  attendee_name: string;
  attendee_email: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  status: string;
  event_type_id: string;
  created_at: string;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  audience_count: number;
  subject: string;
  metrics: Record<string, number> | null;
  sent_at: string | null;
  created_at: string;
}

interface FinanceRow {
  id: string;
  type?: string;
  category?: string;
  amount: number;
  currency?: string;
  description?: string | null;
  transaction_date?: string;
  status?: string;
  fees?: number;
  settled_at?: string | null;
  created_at?: string;
}

interface AnalyticsRow {
  event_type: string;
  resource_id: string | null;
  resource_type: string | null;
  session_id: string | null;
  created_at: string;
}

interface ReviewRow {
  id: string;
  customer_name: string;
  rating: number;
  title: string | null;
  content: string | null;
  product_id: string | null;
  created_at: string;
}

export interface MerchantDataSnapshot {
  period: MerchantPeriod;
  generated_at: string;
  stores?: StoreRow[];
  products?: ProductRow[];
  orders?: OrderRow[];
  customers?: CustomerRow[];
  events?: EventRow[];
  bookings?: BookingRow[];
  campaigns?: CampaignRow[];
  transactions?: FinanceRow[];
  expenses?: FinanceRow[];
  payouts?: FinanceRow[];
  refunds?: FinanceRow[];
  analytics?: AnalyticsRow[];
  reviews?: ReviewRow[];
  summary: Record<string, unknown>;
}

interface MerchantDataContext {
  businessId: string;
  supabase: SupabaseClient;
}

type DataDomain =
  | "stores"
  | "products"
  | "orders"
  | "customers"
  | "events"
  | "bookings"
  | "campaigns"
  | "finance"
  | "analytics"
  | "reviews";

const CAPABILITY_DOMAINS: Partial<Record<MerchantCapabilityId, DataDomain[]>> = {
  daily_business_briefing: ["stores", "products", "orders", "bookings", "campaigns", "finance"],
  business_data_search: ["stores", "products", "orders", "customers", "events", "bookings", "campaigns", "finance"],
  order_management: ["stores", "orders"],
  product_creation: ["stores", "products"],
  product_editing: ["stores", "products"],
  inventory_monitoring: ["stores", "products", "orders"],
  restock_recommendations: ["stores", "products", "orders"],
  bulk_action_planner: ["stores", "products", "orders", "customers"],
  store_health_check: ["stores", "products"],
  sales_performance_analysis: ["stores", "products", "orders"],
  demand_forecasting: ["products", "orders"],
  pricing_recommendations: ["products", "orders"],
  discount_builder: ["products", "orders"],
  promotion_effectiveness: ["orders", "campaigns"],
  upsell_recommendations: ["products", "orders"],
  bundle_generator: ["products", "orders"],
  abandoned_cart_recovery: ["products", "analytics"],
  revenue_opportunity_detection: ["products", "orders", "analytics"],
  profitability_calculator: ["orders", "finance"],
  customer_profile_summary: ["orders", "customers"],
  customer_segmentation: ["customers"],
  personalized_campaign: ["customers", "campaigns", "products"],
  customer_support_copilot: ["orders", "products"],
  complaint_resolution: ["orders", "reviews"],
  review_response: ["reviews", "products"],
  customer_retention_alerts: ["customers"],
  win_back_campaign: ["customers", "campaigns"],
  product_description_generator: ["products"],
  product_seo: ["products"],
  image_quality_audit: ["products"],
  product_image_brief: ["products"],
  catalog_cleanup: ["products"],
  automatic_categorization: ["products"],
  digital_file_validation: ["products"],
  event_setup: ["events"],
  service_setup: ["products", "bookings"],
  cash_flow_forecast: ["orders", "finance"],
  payout_reconciliation: ["orders", "finance"],
  refund_risk_detection: ["orders", "finance"],
  fraud_review: ["orders"],
  invoice_receipt_assistant: ["orders", "finance"],
  expense_categorization: ["finance"],
  schedule_optimization: ["bookings"],
  no_show_reduction: ["bookings"],
  business_goal_planner: ["orders", "products", "customers"],
  opportunity_monitor: ["stores", "products", "orders", "customers", "bookings", "campaigns", "finance", "analytics"],
};

const MAX_ROWS = 500;

function periodStart(period: MerchantPeriod): string | null {
  if (period === "all") return null;
  const days = Number(period.slice(0, -1));
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function assertQuery<T>(data: T | null, error: { message: string } | null): T {
  if (error) throw new Error(error.message);
  return data ?? ([] as T);
}

function sum(rows: Array<{ amount?: number; total?: number }>, field: "amount" | "total"): number {
  return rows.reduce((total, row) => total + Number(row[field] ?? 0), 0);
}

function summarize(snapshot: Omit<MerchantDataSnapshot, "summary">): Record<string, unknown> {
  const paidOrders = (snapshot.orders ?? []).filter((order) =>
    ["paid", "processing", "fulfilled"].includes(order.status),
  );
  const products = snapshot.products ?? [];
  const bookings = snapshot.bookings ?? [];
  const customers = snapshot.customers ?? [];
  const expenses = snapshot.expenses ?? [];
  const refunds = snapshot.refunds ?? [];
  const payouts = snapshot.payouts ?? [];
  const analytics = snapshot.analytics ?? [];
  const boundedDomains = Object.entries(snapshot)
    .filter(([, value]) => Array.isArray(value) && value.length >= MAX_ROWS)
    .map(([domain]) => domain);

  const salesByProduct = new Map<string, { name: string; units: number; revenue: number }>();
  for (const order of paidOrders) {
    for (const item of Array.isArray(order.items) ? order.items : []) {
      if (!item.product_id) continue;
      const current = salesByProduct.get(item.product_id) ?? {
        name: item.product_name || item.name || "Product",
        units: 0,
        revenue: 0,
      };
      const quantity = Number(item.quantity ?? 1);
      current.units += quantity;
      current.revenue += Number(item.price ?? 0) * quantity;
      salesByProduct.set(item.product_id, current);
    }
  }

  const analyticsCounts = analytics.reduce<Record<string, number>>((counts, event) => {
    counts[event.event_type] = (counts[event.event_type] ?? 0) + 1;
    return counts;
  }, {});

  return {
    data_quality: {
      row_limit: MAX_ROWS,
      potentially_partial_domains: boundedDomains,
    },
    store_count: snapshot.stores?.length ?? 0,
    live_store_count: snapshot.stores?.filter((store) => store.is_live).length ?? 0,
    product_count: products.length,
    published_product_count: products.filter((product) => product.status === "published").length,
    draft_product_count: products.filter((product) => product.status === "draft").length,
    low_stock_products: products
      .filter((product) => product.stock !== null && product.stock <= 5)
      .sort((left, right) => Number(left.stock) - Number(right.stock))
      .slice(0, 20),
    products_missing_content: products
      .filter((product) => !product.description?.trim() || !product.cover_image)
      .slice(0, 20),
    order_count: snapshot.orders?.length ?? 0,
    paid_order_count: paidOrders.length,
    revenue: sum(paidOrders, "total"),
    average_order_value: paidOrders.length ? sum(paidOrders, "total") / paidOrders.length : 0,
    discounted_revenue: paidOrders.reduce((total, order) => total + Number(order.discount ?? 0), 0),
    top_products: [...salesByProduct.values()]
      .sort((left, right) => right.units - left.units)
      .slice(0, 10),
    customer_count: customers.length,
    high_value_customers: customers
      .filter((customer) => Number(customer.lifetime_value) > 0)
      .sort((left, right) => Number(right.lifetime_value) - Number(left.lifetime_value))
      .slice(0, 20),
    upcoming_event_count: snapshot.events?.filter((event) => !event.end_date || new Date(event.end_date) >= new Date()).length ?? 0,
    booking_count: bookings.length,
    no_show_count: bookings.filter((booking) => booking.status === "no_show").length,
    cancelled_booking_count: bookings.filter((booking) => booking.status === "cancelled").length,
    campaign_count: snapshot.campaigns?.length ?? 0,
    total_expenses: sum(expenses, "amount"),
    total_refunds: sum(refunds, "amount"),
    total_payouts: sum(payouts, "amount"),
    analytics: analyticsCounts,
    review_count: snapshot.reviews?.length ?? 0,
    average_rating: snapshot.reviews?.length
      ? snapshot.reviews.reduce((total, review) => total + Number(review.rating), 0) / snapshot.reviews.length
      : 0,
  };
}

export async function loadMerchantData(
  context: MerchantDataContext,
  capabilityId: MerchantCapabilityId,
  period: MerchantPeriod,
): Promise<MerchantDataSnapshot> {
  const { businessId, supabase } = context;
  const domains = new Set(CAPABILITY_DOMAINS[capabilityId] ?? []);
  const start = periodStart(period);

  const storeResult = await supabase
    .from("stores")
    .select("id, name, slug, is_live, sells_in_person, created_at")
    .eq("business_id", businessId)
    .order("created_at", { ascending: false })
    .limit(50);
  const stores = assertQuery(storeResult.data, storeResult.error) as StoreRow[];
  const storeIds = stores.map((store) => store.id);

  const snapshot: Omit<MerchantDataSnapshot, "summary"> = {
    period,
    generated_at: new Date().toISOString(),
    ...(domains.has("stores") ? { stores } : {}),
  };

  if (domains.has("products") && storeIds.length) {
    const result = await supabase
      .from("products")
      .select("id, store_id, name, description, price, compare_at_price, currency, type, status, cover_image, images, stock, orders_count, digital, updated_at")
      .in("store_id", storeIds)
      .order("updated_at", { ascending: false })
      .limit(MAX_ROWS);
    snapshot.products = assertQuery(result.data, result.error) as ProductRow[];
  }

  if (domains.has("orders") && storeIds.length) {
    let query = supabase
      .from("store_orders")
      .select("id, store_id, order_number, customer_name, customer_email, items, subtotal, discount, total, currency, status, shipping_status, created_at")
      .in("store_id", storeIds)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (start) query = query.gte("created_at", start);
    const result = await query;
    snapshot.orders = assertQuery(result.data, result.error) as OrderRow[];
  }

  if (domains.has("customers") && storeIds.length) {
    const result = await supabase
      .from("store_customers")
      .select("id, store_id, name, email, orders_count, lifetime_value, first_order_at, last_order_at")
      .in("store_id", storeIds)
      .order("last_order_at", { ascending: false })
      .limit(MAX_ROWS);
    snapshot.customers = assertQuery(result.data, result.error) as CustomerRow[];
  }

  if (domains.has("events")) {
    const result = await supabase
      .from("events")
      .select("id, event_name, status, event_type, start_date, end_date, venue, is_online, is_physical")
      .eq("business_id", businessId)
      .limit(200);
    snapshot.events = assertQuery(result.data, result.error) as EventRow[];
  }

  if (domains.has("bookings")) {
    const typeResult = await supabase
      .from("event_types")
      .select("id")
      .eq("business_id", businessId)
      .limit(100);
    const typeIds = (assertQuery(typeResult.data, typeResult.error) as Array<{ id: string }>).map((type) => type.id);
    if (typeIds.length) {
      let query = supabase
        .from("scheduled_bookings")
        .select("id, attendee_name, attendee_email, booking_date, start_time, end_time, status, event_type_id, created_at")
        .in("event_type_id", typeIds)
        .order("booking_date", { ascending: false })
        .limit(MAX_ROWS);
      if (start) query = query.gte("created_at", start);
      const result = await query;
      snapshot.bookings = assertQuery(result.data, result.error) as BookingRow[];
    }
  }

  if (domains.has("campaigns")) {
    const result = await supabase
      .from("campaigns")
      .select("id, name, status, audience_count, subject, metrics, sent_at, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(100);
    snapshot.campaigns = assertQuery(result.data, result.error) as CampaignRow[];
  }

  if (domains.has("finance")) {
    let transactionQuery = supabase
      .from("bookkeeping_transactions")
      .select("id, type, category, amount, currency, description, transaction_date, created_at")
      .eq("business_id", businessId)
      .order("transaction_date", { ascending: false })
      .limit(MAX_ROWS);
    let expenseQuery = supabase
      .from("expenses")
      .select("id, category, amount, currency, description, transaction_date, created_at")
      .eq("business_id", businessId)
      .order("transaction_date", { ascending: false })
      .limit(MAX_ROWS);
    let payoutQuery = supabase
      .from("payout_batches")
      .select("id, amount, fees, status, settled_at, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(200);
    let refundQuery = supabase
      .from("financial_refunds")
      .select("id, amount, currency, reason, status, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (start) {
      transactionQuery = transactionQuery.gte("transaction_date", start);
      expenseQuery = expenseQuery.gte("transaction_date", start);
      payoutQuery = payoutQuery.gte("created_at", start);
      refundQuery = refundQuery.gte("created_at", start);
    }
    const [transactions, expenses, payouts, refunds] = await Promise.all([
      transactionQuery,
      expenseQuery,
      payoutQuery,
      refundQuery,
    ]);
    snapshot.transactions = assertQuery(transactions.data, transactions.error) as FinanceRow[];
    snapshot.expenses = assertQuery(expenses.data, expenses.error) as FinanceRow[];
    snapshot.payouts = assertQuery(payouts.data, payouts.error) as FinanceRow[];
    snapshot.refunds = assertQuery(refunds.data, refunds.error) as FinanceRow[];
  }

  if (domains.has("analytics") && storeIds.length) {
    let query = supabase
      .from("analytics_events")
      .select("event_type, resource_id, resource_type, session_id, created_at")
      .in("store_id", storeIds)
      .order("created_at", { ascending: false })
      .limit(MAX_ROWS);
    if (start) query = query.gte("created_at", start);
    const result = await query;
    snapshot.analytics = assertQuery(result.data, result.error) as AnalyticsRow[];
  }

  if (domains.has("reviews") && storeIds.length) {
    const result = await supabase
      .from("store_reviews")
      .select("id, customer_name, rating, title, content, product_id, created_at")
      .in("store_id", storeIds)
      .order("created_at", { ascending: false })
      .limit(100);
    snapshot.reviews = assertQuery(result.data, result.error) as ReviewRow[];
  }

  return { ...snapshot, summary: summarize(snapshot) };
}
