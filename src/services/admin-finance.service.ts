/**
 * Admin Finance Service
 * Platform-level P&L, revenue breakdown, and financial analytics for admin dashboard
 * Currency: Nigerian Naira (NGN)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

const PLAN_PRICES: Record<string, number> = {
  starter: 0,
  plus: 4000,
  pro: 7500,
};

// Platform fee: 1.5% + ₦100, capped at ₦2000
function calcPlatformFee(amount: number): number {
  return Math.min(Math.round(amount * 0.015) + 100, 2000);
}

export interface PlatformRevenueSummary {
  subscriptionRevenue: number;
  transactionFees: number;
  totalPayouts: number;
  netRevenue: number;
  currency: string;
}

export interface RevenueByMonth {
  month: string;
  subscriptionRevenue: number;
  transactionFees: number;
  total: number;
}

export interface TopRevenueBusiness {
  businessId: string;
  businessName: string;
  totalRevenue: number;
  orderCount: number;
  plan: string;
}

export interface PlatformPnL {
  revenue: number;
  costs: number;
  grossProfit: number;
  margin: number;
}

export interface SubscriptionPlanStat {
  plan: string;
  count: number;
  monthlyRevenue: number;
  annualRevenue: number;
}

export interface SubscriptionRevenueSummary {
  plans: SubscriptionPlanStat[];
  totalMRR: number;
  totalARR: number;
}

export class AdminFinanceService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Platform-wide revenue summary
   */
  async getPlatformRevenueSummary(
    supabase?: SupabaseClient,
  ): Promise<PlatformRevenueSummary> {
    const client = this.getClient(supabase);

    // Subscription revenue from active paid businesses
    const { data: activeSubs } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["active", "trialing"])
      .neq("subscription_plan", "starter");

    const subscriptionRevenue = (activeSubs || []).reduce(
      (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    // Transaction fees from store orders
    let transactionFees = 0;
    const { data: storeOrders } = await client
      .from("store_orders")
      .select("total")
      .eq("status", "completed");

    for (const order of storeOrders || []) {
      transactionFees += calcPlatformFee(order.total || 0);
    }

    // Transaction fees from event orders
    const { data: eventOrders } = await client
      .from("orders")
      .select("total_amount")
      .eq("status", "paid");

    for (const order of eventOrders || []) {
      transactionFees += calcPlatformFee(order.total_amount || 0);
    }

    // Platform-wide payout totals are tracked in Paystack settlements
    // (admin Payouts tab), not mirrored locally.
    const totalPayouts = 0;

    const netRevenue = subscriptionRevenue + transactionFees;

    return {
      subscriptionRevenue,
      transactionFees,
      totalPayouts,
      netRevenue,
      currency: "NGN",
    };
  }

  /**
   * Monthly revenue breakdown for the last N months
   */
  async getRevenueByMonth(
    supabase?: SupabaseClient,
    months: number = 6,
  ): Promise<RevenueByMonth[]> {
    const client = this.getClient(supabase);
    const results: RevenueByMonth[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const monthStart = new Date();
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      monthStart.setMonth(monthStart.getMonth() - i);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);

      const monthLabel = monthStart.toLocaleString("default", {
        month: "short",
        year: "numeric",
      });

      // Subscription revenue: businesses that became paid this month
      const { data: newPaidSubs } = await client
        .from("businesses")
        .select("subscription_plan")
        .neq("subscription_plan", "starter")
        .gte("created_at", monthStart.toISOString())
        .lt("created_at", monthEnd.toISOString());

      const subscriptionRevenue = (newPaidSubs || []).reduce(
        (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
        0,
      );

      // Transaction fees from store orders this month
      let transactionFees = 0;
      const { data: storeOrders } = await client
        .from("store_orders")
        .select("total")
        .eq("status", "completed")
        .gte("created_at", monthStart.toISOString())
        .lt("created_at", monthEnd.toISOString());

      for (const o of storeOrders || []) {
        transactionFees += calcPlatformFee(o.total || 0);
      }

      // Transaction fees from event orders this month
      const { data: eventOrders } = await client
        .from("orders")
        .select("total_amount")
        .eq("status", "paid")
        .gte("created_at", monthStart.toISOString())
        .lt("created_at", monthEnd.toISOString());

      for (const o of eventOrders || []) {
        transactionFees += calcPlatformFee(o.total_amount || 0);
      }

      results.push({
        month: monthLabel,
        subscriptionRevenue,
        transactionFees,
        total: subscriptionRevenue + transactionFees,
      });
    }

    return results;
  }

  /**
   * Top N businesses by gross revenue generated on platform
   */
  async getTopRevenueBusinesses(
    supabase?: SupabaseClient,
    limit: number = 10,
  ): Promise<TopRevenueBusiness[]> {
    const client = this.getClient(supabase);

    // Use the business_revenue_ledger_view if available
    const { data: ledgerData, error } = await client
      .from("business_revenue_ledger_view")
      .select("business_id, amount")
      .eq("status", "completed")
      .limit(5000);

    if (error || !ledgerData) {
      // Fallback: query store_orders directly
      const { data: storeData } = await client
        .from("store_orders")
        .select("total, stores!inner(business_id)")
        .eq("status", "completed")
        .limit(5000);

      const map = new Map<string, { revenue: number; count: number }>();
      for (const o of storeData || []) {
        const bid = (o as any).stores?.business_id;
        if (!bid) continue;
        const existing = map.get(bid) || { revenue: 0, count: 0 };
        existing.revenue += o.total || 0;
        existing.count++;
        map.set(bid, existing);
      }

      const sorted = Array.from(map.entries())
        .sort((a, b) => b[1].revenue - a[1].revenue)
        .slice(0, limit);

      const results: TopRevenueBusiness[] = [];
      for (const [businessId, { revenue, count }] of sorted) {
        const { data: biz } = await client
          .from("businesses")
          .select("name, subscription_plan")
          .eq("id", businessId)
          .maybeSingle();

        results.push({
          businessId,
          businessName: biz?.name || "Unknown",
          totalRevenue: revenue,
          orderCount: count,
          plan: biz?.subscription_plan || "starter",
        });
      }

      return results;
    }

    // Aggregate from ledger view
    const map = new Map<string, { revenue: number; count: number }>();
    for (const row of ledgerData) {
      const existing = map.get(row.business_id) || { revenue: 0, count: 0 };
      existing.revenue += row.amount || 0;
      existing.count++;
      map.set(row.business_id, existing);
    }

    const sorted = Array.from(map.entries())
      .sort((a, b) => b[1].revenue - a[1].revenue)
      .slice(0, limit);

    const results: TopRevenueBusiness[] = [];
    for (const [businessId, { revenue, count }] of sorted) {
      const { data: biz } = await client
        .from("businesses")
        .select("name, subscription_plan")
        .eq("id", businessId)
        .maybeSingle();

      results.push({
        businessId,
        businessName: biz?.name || "Unknown",
        totalRevenue: revenue,
        orderCount: count,
        plan: biz?.subscription_plan || "starter",
      });
    }

    return results;
  }

  /**
   * Platform P&L summary
   */
  async getPlatformPnL(supabase?: SupabaseClient): Promise<PlatformPnL> {
    const summary = await this.getPlatformRevenueSummary(supabase);
    const revenue = summary.netRevenue;
    const costs = summary.totalPayouts;
    const grossProfit = revenue - costs;
    const margin =
      revenue > 0 ? parseFloat(((grossProfit / revenue) * 100).toFixed(2)) : 0;

    return { revenue, costs, grossProfit, margin };
  }

  /**
   * Subscription revenue breakdown by plan
   */
  async getSubscriptionRevenueSummary(
    supabase?: SupabaseClient,
  ): Promise<SubscriptionRevenueSummary> {
    const client = this.getClient(supabase);

    const { data } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["active", "trialing"]);

    const counts: Record<string, number> = {};
    for (const b of data || []) {
      const plan = b.subscription_plan || "starter";
      counts[plan] = (counts[plan] || 0) + 1;
    }

    const plans: SubscriptionPlanStat[] = Object.entries(counts).map(
      ([plan, count]) => {
        const monthlyRevenue = count * (PLAN_PRICES[plan] || 0);
        return {
          plan,
          count,
          monthlyRevenue,
          annualRevenue: monthlyRevenue * 12,
        };
      },
    );

    const totalMRR = plans.reduce((acc, p) => acc + p.monthlyRevenue, 0);
    return { plans, totalMRR, totalARR: totalMRR * 12 };
  }
}

export const adminFinanceService = new AdminFinanceService();
