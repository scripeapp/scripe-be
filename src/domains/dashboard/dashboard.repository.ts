import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";

export interface DashboardStats {
  readonly revenue: { readonly total: number; readonly paid_count: number };
  readonly total_orders: number;
  readonly total_customers: number;
  readonly chart: { readonly date: string; readonly revenue: number }[];
}

/**
 * Business-wide overview figures for the given currency and period.
 * Revenue is drawn from captured payments in that currency; order and
 * customer counts are currency-agnostic (an order can be paid in any asset).
 * `since === null` means "all time".
 */
export async function getStats(
  context: DatabaseContext,
  businessId: string,
  currency: string,
  since: Date | null,
): Promise<DashboardStats> {
  const sinceIso = since ? since.toISOString() : null;

  const revenue = await sql<{ total: string | null; paid_count: string }>`
    select coalesce(sum("amountMinor"), 0)::text as total, count(*)::text as paid_count
    from app.payments
    where "businessId" = ${businessId}::uuid
      and "assetCode" = ${currency}
      and "status" = 'captured'
      and (${sinceIso}::timestamptz is null or "createdAt" >= ${sinceIso}::timestamptz)
  `.execute(context.transaction);

  const orders = await sql<{ total_orders: string; total_customers: string }>`
    select count(*)::text as total_orders,
           count(distinct "customerPartyId")::text as total_customers
    from app.orders
    where "businessId" = ${businessId}::uuid
      and (${sinceIso}::timestamptz is null or "createdAt" >= ${sinceIso}::timestamptz)
  `.execute(context.transaction);

  const chart = await sql<{ date: string; revenue: string }>`
    with bounds as (
      select coalesce(
        ${sinceIso}::timestamptz,
        (select min("createdAt") from app.payments where "businessId" = ${businessId}::uuid and "assetCode" = ${currency} and "status" = 'captured'),
        now() - interval '30 days'
      ) as start_time,
      now() as end_time
    ),
    date_series as (
      select generate_series(
        date_trunc('day', (select start_time from bounds)),
        date_trunc('day', (select end_time from bounds)),
        '1 day'::interval
      )::date as day
    ),
    daily_totals as (
      select date_trunc('day', "createdAt")::date as day,
             sum("amountMinor") as total
      from app.payments
      where "businessId" = ${businessId}::uuid
        and "assetCode" = ${currency}
        and "status" = 'captured'
        and (${sinceIso}::timestamptz is null or "createdAt" >= ${sinceIso}::timestamptz)
      group by 1
    )
    select to_char(ds.day, 'YYYY-MM-DD') as date,
           coalesce(dt.total, 0)::text as revenue
    from date_series ds
    left join daily_totals dt on dt.day = ds.day
    order by ds.day asc
  `.execute(context.transaction);

  const r = revenue.rows[0];
  const o = orders.rows[0];
  return {
    revenue: {
      total: Number(r?.total ?? 0) / 100,
      paid_count: Number(r?.paid_count ?? 0),
    },
    total_orders: Number(o?.total_orders ?? 0),
    total_customers: Number(o?.total_customers ?? 0),
    chart: chart.rows.map((row) => ({
      date: row.date,
      revenue: Number(row.revenue ?? 0) / 100,
    })),
  };
}

export interface PosAnalytics {
  readonly gross_sales: number;
  readonly orders_count: number;
  readonly discounts_total: number;
  readonly returns_total: number;
  readonly sales_chart: { date: string; value: number }[];
}

/**
 * POS-channel figures for the Point of Sale overview: gross sales (captured
 * payments), order count, discounts, returns (refunded payments) and a daily
 * revenue series, all scoped to the store's POS-kind channels.
 */
export async function getPosAnalytics(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  since: Date | null,
): Promise<PosAnalytics> {
  const sinceIso = since ? since.toISOString() : null;

  const summary = await sql<{ gross: string | null; orders: string; discounts: string | null; returns: string | null }>`
    with pos_orders as (
      select o."id", o."discountMinor", o."createdAt"
      from app.orders o
      join app.sales_channels c on c."id" = o."channelId" and c."kind" = 'pos'
      where o."businessId" = ${businessId}::uuid
        and o."storeId" = ${storeId}::uuid
        and (${sinceIso}::timestamptz is null or o."createdAt" >= ${sinceIso}::timestamptz)
    )
    select
      coalesce((select sum(p."amountMinor") from app.payments p
                join pos_orders po on po."id" = p."orderId" where p."status" = 'captured'), 0)::text as gross,
      (select count(*) from pos_orders)::text as orders,
      coalesce((select sum("discountMinor") from pos_orders), 0)::text as discounts,
      coalesce((select sum(p."amountMinor") from app.payments p
                join pos_orders po on po."id" = p."orderId" where p."status" = 'refunded'), 0)::text as returns
  `.execute(context.transaction);

  const chart = await sql<{ date: string; value: string }>`
    select to_char(date_trunc('day', o."createdAt"), 'YYYY-MM-DD') as date,
           coalesce(sum(p."amountMinor") filter (where p."status" = 'captured'), 0)::text as value
    from app.orders o
    join app.sales_channels c on c."id" = o."channelId" and c."kind" = 'pos'
    left join app.payments p on p."orderId" = o."id"
    where o."businessId" = ${businessId}::uuid
      and o."storeId" = ${storeId}::uuid
      and (${sinceIso}::timestamptz is null or o."createdAt" >= ${sinceIso}::timestamptz)
    group by 1
    order by 1
  `.execute(context.transaction);

  const s = summary.rows[0];
  return {
    gross_sales: Number(s?.gross ?? 0) / 100,
    orders_count: Number(s?.orders ?? 0),
    discounts_total: Number(s?.discounts ?? 0) / 100,
    returns_total: Number(s?.returns ?? 0) / 100,
    sales_chart: chart.rows.map((row) => ({ date: row.date, value: Number(row.value) / 100 })),
  };
}

export interface StoreLocationBreakdown {
  readonly id: string;
  readonly name: string;
  readonly net_sales: number;
  readonly transactions: number;
  readonly average_sale: number;
}

export interface StoreAnalytics {
  readonly total_revenue: number;
  readonly total_orders: number;
  readonly total_customers: number;
  readonly total_products: number;
  readonly locations?: StoreLocationBreakdown[];
}

/**
 * Store-scoped figures for the store overview and branch dashboard.
 * Revenue is the captured-payment total for orders in the store (all assets —
 * the UI labels this under the store's own currency and has no per-currency
 * split). When `branchId` is null, a per-location breakdown is included.
 */
export async function getStoreAnalytics(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  branchId: string | null,
): Promise<StoreAnalytics> {
  const revenue = await sql<{ total: string | null; total_orders: string; total_customers: string }>`
    select
      coalesce(sum(paid.captured), 0)::text as total,
      count(*)::text as total_orders,
      count(distinct o."customerPartyId")::text as total_customers
    from app.orders o
    left join lateral (
      select coalesce(sum(p."amountMinor"), 0) as captured
      from app.payments p
      where p."orderId" = o."id" and p."status" = 'captured'
    ) paid on true
    where o."businessId" = ${businessId}::uuid
      and o."storeId" = ${storeId}::uuid
      and (${branchId}::uuid is null or o."locationId" = ${branchId}::uuid)
  `.execute(context.transaction);

  const products = await sql<{ total_products: string }>`
    select count(*)::text as total_products
    from app.products
    where "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
      and "status" <> 'archived'
  `.execute(context.transaction);

  const summary = revenue.rows[0];
  const result: StoreAnalytics = {
    total_revenue: Number(summary?.total ?? 0) / 100,
    total_orders: Number(summary?.total_orders ?? 0),
    total_customers: Number(summary?.total_customers ?? 0),
    total_products: Number(products.rows[0]?.total_products ?? 0),
  };

  if (branchId) return result;

  const locations = await sql<{ id: string; name: string; net_sales: string | null; transactions: string }>`
    select l."id", l."name",
      coalesce(sum(paid.captured), 0)::text as net_sales,
      count(o."id")::text as transactions
    from app.locations l
    left join app.orders o
      on o."locationId" = l."id" and o."storeId" = ${storeId}::uuid
    left join lateral (
      select coalesce(sum(p."amountMinor"), 0) as captured
      from app.payments p
      where p."orderId" = o."id" and p."status" = 'captured'
    ) paid on true
    where l."businessId" = ${businessId}::uuid
    group by l."id", l."name"
    order by l."name"
  `.execute(context.transaction);

  return {
    ...result,
    locations: locations.rows.map((row) => {
      const netSales = Number(row.net_sales ?? 0) / 100;
      const transactions = Number(row.transactions ?? 0);
      return {
        id: row.id,
        name: row.name,
        net_sales: netSales,
        transactions,
        average_sale: transactions > 0 ? Math.round(netSales / transactions) : 0,
      };
    }),
  };
}
