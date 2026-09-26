import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";

export interface DashboardStats {
  readonly revenue: { readonly total: number; readonly paid_count: number };
  readonly total_orders: number;
  readonly total_customers: number;
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

  const r = revenue.rows[0];
  const o = orders.rows[0];
  return {
    revenue: {
      total: Number(r?.total ?? 0),
      paid_count: Number(r?.paid_count ?? 0),
    },
    total_orders: Number(o?.total_orders ?? 0),
    total_customers: Number(o?.total_customers ?? 0),
  };
}
