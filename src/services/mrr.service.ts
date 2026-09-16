/**
 * MRR Analytics Service
 * Computes Monthly Recurring Revenue, ARR, churn, and growth metrics
 * Currency: Nigerian Naira (NGN)
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

const PLAN_PRICES: Record<string, number> = {
  starter: 0,
  plus: 4000,
  pro: 7500,
};

export interface MRRBreakdown {
  mrr: number;
  breakdown: {
    starter: number;
    plus: number;
    pro: number;
    plusCount: number;
    proCount: number;
    starterCount: number;
  };
}

export interface ARRResult {
  arr: number;
  mrr: number;
}

export interface ChurnResult {
  churnRate: number;
  churned: number;
  activeAtPeriodStart: number;
}

export interface MRRGrowthResult {
  currentMRR: number;
  previousMRR: number;
  growth: number;
  growthPercent: number;
}

export interface PlanDistribution {
  starter: number;
  plus: number;
  pro: number;
  total: number;
  paidPercent: number;
}

export interface NewSubscriptions {
  count: number;
  revenue: number;
}

export interface RevenueTimeSeriesPoint {
  month: string;
  mrr: number;
  newRevenue: number;
  churnedRevenue: number;
}

export interface FullAnalytics {
  mrr: MRRBreakdown;
  arr: ARRResult;
  churn: ChurnResult;
  growth: MRRGrowthResult;
  planDistribution: PlanDistribution;
  newSubscriptions: NewSubscriptions;
  timeSeries: RevenueTimeSeriesPoint[];
  generatedAt: string;
}

export class MRRService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Compute MRR from active/trialing businesses
   */
  async getMRR(supabase?: SupabaseClient): Promise<MRRBreakdown> {
    const client = this.getClient(supabase);

    const { data, error } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["active", "trialing"]);

    if (error) throw error;

    const counts = { starter: 0, plus: 0, pro: 0 };
    for (const b of data || []) {
      const plan = (b.subscription_plan as string) || "starter";
      if (plan in counts) counts[plan as keyof typeof counts]++;
    }

    const mrr =
      counts.plus * PLAN_PRICES.plus + counts.pro * PLAN_PRICES.pro;

    return {
      mrr,
      breakdown: {
        starter: counts.starter * 0,
        plus: counts.plus * PLAN_PRICES.plus,
        pro: counts.pro * PLAN_PRICES.pro,
        plusCount: counts.plus,
        proCount: counts.pro,
        starterCount: counts.starter,
      },
    };
  }

  /**
   * ARR = MRR × 12
   */
  async getARR(supabase?: SupabaseClient): Promise<ARRResult> {
    const { mrr } = await this.getMRR(supabase);
    return { arr: mrr * 12, mrr };
  }

  /**
   * Churn rate: businesses that cancelled/expired in the last 30 days
   * vs total active at start of period
   */
  async getChurnRate(supabase?: SupabaseClient): Promise<ChurnResult> {
    const client = this.getClient(supabase);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Businesses that churned in the last 30 days
    const { count: churned } = await client
      .from("businesses")
      .select("*", { count: "exact", head: true })
      .in("subscription_status", ["cancelled", "expired"])
      .neq("subscription_plan", "starter")
      .gte("updated_at", thirtyDaysAgo.toISOString());

    // Active paid businesses (current)
    const { count: currentActive } = await client
      .from("businesses")
      .select("*", { count: "exact", head: true })
      .in("subscription_status", ["active", "trialing"])
      .neq("subscription_plan", "starter");

    const churnedCount = churned || 0;
    const activeAtPeriodStart = (currentActive || 0) + churnedCount;
    const churnRate =
      activeAtPeriodStart > 0
        ? parseFloat(((churnedCount / activeAtPeriodStart) * 100).toFixed(2))
        : 0;

    return { churnRate, churned: churnedCount, activeAtPeriodStart };
  }

  /**
   * MRR growth: compare current vs 30 days ago using created_at/updated_at
   */
  async getMRRGrowth(supabase?: SupabaseClient): Promise<MRRGrowthResult> {
    const client = this.getClient(supabase);
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    // Current paid subscribers
    const { data: currentSubs } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["active", "trialing"])
      .neq("subscription_plan", "starter");

    // New paid subscribers added in last 30 days
    const { data: newSubs } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["active", "trialing"])
      .neq("subscription_plan", "starter")
      .gte("created_at", thirtyDaysAgo.toISOString());

    // Churned in last 30 days
    const { data: churnedSubs } = await client
      .from("businesses")
      .select("subscription_plan")
      .in("subscription_status", ["cancelled", "expired"])
      .neq("subscription_plan", "starter")
      .gte("updated_at", thirtyDaysAgo.toISOString());

    const currentMRR = (currentSubs || []).reduce(
      (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    const newRevenue = (newSubs || []).reduce(
      (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    const churnedRevenue = (churnedSubs || []).reduce(
      (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    const previousMRR = currentMRR - newRevenue + churnedRevenue;
    const growth = currentMRR - previousMRR;
    const growthPercent =
      previousMRR > 0
        ? parseFloat(((growth / previousMRR) * 100).toFixed(2))
        : currentMRR > 0
          ? 100
          : 0;

    return { currentMRR, previousMRR, growth, growthPercent };
  }

  /**
   * Count of businesses per plan
   */
  async getPlanDistribution(
    supabase?: SupabaseClient,
  ): Promise<PlanDistribution> {
    const client = this.getClient(supabase);

    const { data } = await client
      .from("businesses")
      .select("subscription_plan, subscription_status");

    const counts = { starter: 0, plus: 0, pro: 0 };
    for (const b of data || []) {
      const plan = (b.subscription_plan as string) || "starter";
      if (plan in counts) counts[plan as keyof typeof counts]++;
    }

    const total = counts.starter + counts.plus + counts.pro;
    const paid = counts.plus + counts.pro;
    const paidPercent =
      total > 0 ? parseFloat(((paid / total) * 100).toFixed(2)) : 0;

    return { ...counts, total, paidPercent };
  }

  /**
   * New paid subscriptions in last N days
   */
  async getNewSubscriptions(
    supabase?: SupabaseClient,
    days: number = 30,
  ): Promise<NewSubscriptions> {
    const client = this.getClient(supabase);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data } = await client
      .from("businesses")
      .select("subscription_plan")
      .neq("subscription_plan", "starter")
      .in("subscription_status", ["active", "trialing"])
      .gte("created_at", since.toISOString());

    const count = (data || []).length;
    const revenue = (data || []).reduce(
      (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    return { count, revenue };
  }

  /**
   * Monthly revenue time series for last N months
   */
  async getRevenueTimeSeries(
    supabase?: SupabaseClient,
    months: number = 6,
  ): Promise<RevenueTimeSeriesPoint[]> {
    const client = this.getClient(supabase);
    const results: RevenueTimeSeriesPoint[] = [];

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

      // Subs active during this month (created before end, not cancelled before start)
      const { data: activeSubs } = await client
        .from("businesses")
        .select("subscription_plan")
        .neq("subscription_plan", "starter")
        .lte("created_at", monthEnd.toISOString())
        .or(
          `subscription_status.in.(active,trialing),and(subscription_status.in.(cancelled,expired),updated_at.gte.${monthEnd.toISOString()})`,
        );

      // New subs this month
      const { data: newSubs } = await client
        .from("businesses")
        .select("subscription_plan")
        .neq("subscription_plan", "starter")
        .gte("created_at", monthStart.toISOString())
        .lt("created_at", monthEnd.toISOString());

      // Churned this month
      const { data: churnedSubs } = await client
        .from("businesses")
        .select("subscription_plan")
        .in("subscription_status", ["cancelled", "expired"])
        .neq("subscription_plan", "starter")
        .gte("updated_at", monthStart.toISOString())
        .lt("updated_at", monthEnd.toISOString());

      const mrr = (activeSubs || []).reduce(
        (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
        0,
      );
      const newRevenue = (newSubs || []).reduce(
        (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
        0,
      );
      const churnedRevenue = (churnedSubs || []).reduce(
        (acc, b) => acc + (PLAN_PRICES[b.subscription_plan] || 0),
        0,
      );

      results.push({ month: monthLabel, mrr, newRevenue, churnedRevenue });
    }

    return results;
  }

  /**
   * Full analytics rollup for the admin dashboard
   */
  async getFullAnalytics(supabase?: SupabaseClient): Promise<FullAnalytics> {
    const [mrr, arr, churn, growth, planDistribution, newSubscriptions, timeSeries] =
      await Promise.all([
        this.getMRR(supabase),
        this.getARR(supabase),
        this.getChurnRate(supabase),
        this.getMRRGrowth(supabase),
        this.getPlanDistribution(supabase),
        this.getNewSubscriptions(supabase, 30),
        this.getRevenueTimeSeries(supabase, 6),
      ]);

    return {
      mrr,
      arr,
      churn,
      growth,
      planDistribution,
      newSubscriptions,
      timeSeries,
      generatedAt: new Date().toISOString(),
    };
  }
}

export const mrrService = new MRRService();
