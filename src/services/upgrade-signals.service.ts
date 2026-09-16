/**
 * Plan Upgrade Signals Service
 * Tracks when businesses hit plan limits — prime upsell opportunities
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

export interface UpgradeSignal {
  id: string;
  business_id: string;
  resource: string;
  current_plan: string;
  limit_value: number;
  used_value: number;
  hit_count: number;
  first_hit_at: string;
  last_hit_at: string;
  resolved_at: string | null;
  created_at: string;
}

export interface UpgradeSignalWithBusiness extends UpgradeSignal {
  business_name?: string;
  business_email?: string;
}

export interface UpgradeSignalsSummary {
  byResource: Array<{ resource: string; count: number; avgHits: number }>;
  byPlan: Array<{ plan: string; count: number }>;
  totalSignals: number;
  topOpportunities: UpgradeSignalWithBusiness[];
}

export interface GetSignalsOptions {
  page?: number;
  limit?: number;
  plan?: string;
  resource?: string;
  unresolved_only?: boolean;
}

export class UpgradeSignalsService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Record a plan limit hit (upsert — increments hit_count if already exists)
   */
  async recordLimitHit(
    supabase: SupabaseClient | undefined,
    businessId: string,
    resource: string,
    plan: string,
    limitValue: number,
    usedValue: number,
  ): Promise<void> {
    const client = this.getClient(supabase);

    try {
      const now = new Date().toISOString();

      // Check if a signal already exists for this business+resource+plan
      const { data: existing } = await client
        .from("plan_upgrade_signals")
        .select("id, hit_count")
        .eq("business_id", businessId)
        .eq("resource", resource)
        .eq("current_plan", plan)
        .is("resolved_at", null)
        .maybeSingle();

      if (existing) {
        await client
          .from("plan_upgrade_signals")
          .update({
            hit_count: existing.hit_count + 1,
            last_hit_at: now,
            used_value: usedValue,
            updated_at: now,
          })
          .eq("id", existing.id);
      } else {
        await client.from("plan_upgrade_signals").insert({
          business_id: businessId,
          resource,
          current_plan: plan,
          limit_value: limitValue,
          used_value: usedValue,
          hit_count: 1,
          first_hit_at: now,
          last_hit_at: now,
        });
      }
    } catch (err) {
      // Non-blocking — never interrupt the main request flow
      console.error("[UpgradeSignals] recordLimitHit error:", err);
    }
  }

  /**
   * Resolve all signals for a business when they upgrade
   */
  async resolveSignals(
    supabase: SupabaseClient | undefined,
    businessId: string,
  ): Promise<void> {
    const client = this.getClient(supabase);

    try {
      await client
        .from("plan_upgrade_signals")
        .update({
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", businessId)
        .is("resolved_at", null);
    } catch (err) {
      console.error("[UpgradeSignals] resolveSignals error:", err);
    }
  }

  /**
   * List upgrade signals with pagination and filtering
   */
  async getUpgradeSignals(
    supabase: SupabaseClient | undefined,
    options: GetSignalsOptions = {},
  ): Promise<{ data: UpgradeSignalWithBusiness[]; total: number }> {
    const client = this.getClient(supabase);
    const { page = 1, limit = 20, plan, resource, unresolved_only = true } =
      options;
    const offset = (page - 1) * limit;

    let query = client
      .from("plan_upgrade_signals")
      .select(
        `
        *,
        businesses(name, email)
      `,
        { count: "exact" },
      )
      .order("hit_count", { ascending: false })
      .range(offset, offset + limit - 1);

    if (plan) query = query.eq("current_plan", plan);
    if (resource) query = query.eq("resource", resource);
    if (unresolved_only) query = query.is("resolved_at", null);

    const { data, count, error } = await query;
    if (error) throw error;

    const signals: UpgradeSignalWithBusiness[] = (data || []).map(
      (s: any) => ({
        ...s,
        business_name: s.businesses?.name,
        business_email: s.businesses?.email,
      }),
    );

    return { data: signals, total: count || 0 };
  }

  /**
   * Summary of upgrade signals for the admin dashboard
   */
  async getUpgradeSignalsSummary(
    supabase?: SupabaseClient,
  ): Promise<UpgradeSignalsSummary> {
    const client = this.getClient(supabase);

    const { data: allSignals } = await client
      .from("plan_upgrade_signals")
      .select(
        `
        resource, current_plan, hit_count,
        businesses(name, email),
        business_id,
        id,
        limit_value,
        used_value,
        first_hit_at,
        last_hit_at,
        resolved_at,
        created_at
      `,
      )
      .is("resolved_at", null);

    const signals = allSignals || [];

    // Group by resource
    const resourceMap = new Map<
      string,
      { count: number; totalHits: number }
    >();
    const planMap = new Map<string, number>();

    for (const s of signals) {
      const r = resourceMap.get(s.resource) || { count: 0, totalHits: 0 };
      r.count++;
      r.totalHits += s.hit_count;
      resourceMap.set(s.resource, r);

      planMap.set(s.current_plan, (planMap.get(s.current_plan) || 0) + 1);
    }

    const byResource = Array.from(resourceMap.entries())
      .map(([resource, { count, totalHits }]) => ({
        resource,
        count,
        avgHits: parseFloat((totalHits / count).toFixed(1)),
      }))
      .sort((a, b) => b.count - a.count);

    const byPlan = Array.from(planMap.entries())
      .map(([plan, count]) => ({ plan, count }))
      .sort((a, b) => b.count - a.count);

    // Top 5 opportunities by hit_count
    const topOpportunities: UpgradeSignalWithBusiness[] = signals
      .sort((a, b) => b.hit_count - a.hit_count)
      .slice(0, 5)
      .map((s: any) => ({
        ...s,
        business_name: s.businesses?.name,
        business_email: s.businesses?.email,
      }));

    return {
      byResource,
      byPlan,
      totalSignals: signals.length,
      topOpportunities,
    };
  }

  /**
   * Get all upgrade signals for a specific business (for admin business detail page)
   */
  async getBusinessUpgradeSignals(
    supabase: SupabaseClient | undefined,
    businessId: string,
  ): Promise<UpgradeSignal[]> {
    const client = this.getClient(supabase);

    const { data, error } = await client
      .from("plan_upgrade_signals")
      .select("*")
      .eq("business_id", businessId)
      .order("hit_count", { ascending: false });

    if (error) throw error;
    return (data || []) as UpgradeSignal[];
  }
}

export const upgradeSignalsService = new UpgradeSignalsService();
