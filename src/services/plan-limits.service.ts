/**
 * Plan Limits Service
 * Handles plan limit lookups and resource counting
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { supabase as publicSupabase } from "../config/supabase";
import { cacheGet, cacheSet } from "../config/redis";
import {
  PlanLimits,
  PlanFeatures,
  PlanConfig,
  SubscriptionPlan,
  LimitResource,
  FeatureType,
  UsageReport,
  UsageItem,
} from "../types/subscription";

const PLAN_CONFIGS_CACHE_KEY = "plan_configs";
const PLAN_CONFIGS_TTL = 300; // 5 minutes — plan configs rarely change
const CAN_CREATE_TTL = 60; // 60 seconds per business resource check

export class PlanLimitsService {
  private supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase || publicSupabase;
  }

  /**
   * Load plan configs from database (Redis-cached, 5 min TTL)
   */
  async loadPlanConfigs(): Promise<Map<SubscriptionPlan, PlanConfig>> {
    const cached = await cacheGet<Record<string, PlanConfig>>(PLAN_CONFIGS_CACHE_KEY);
    if (cached) {
      return new Map(Object.entries(cached) as [SubscriptionPlan, PlanConfig][]);
    }

    const { data, error } = await this.supabase.from("plan_limits").select("*");

    if (error) {
      console.error("[PlanLimitsService] Error loading plan configs:", error);
      throw error;
    }

    const configMap = new Map<SubscriptionPlan, PlanConfig>();
    const configObj: Record<string, PlanConfig> = {};
    for (const row of data || []) {
      const config: PlanConfig = {
        id: row.id,
        plan: row.plan,
        limits: row.limits,
        features: row.features,
        price_monthly: row.price_monthly || 0,
        price_yearly: row.price_yearly,
        paystack_plan_code: row.paystack_plan_code,
      };
      configMap.set(row.plan as SubscriptionPlan, config);
      configObj[row.plan] = config;
    }

    await cacheSet(PLAN_CONFIGS_CACHE_KEY, configObj, PLAN_CONFIGS_TTL);
    return configMap;
  }

  /**
   * Get limit for a specific resource
   */
  async getPlanLimit(
    plan: SubscriptionPlan,
    resource: LimitResource,
  ): Promise<number | "unlimited"> {
    const configs = await this.loadPlanConfigs();
    const config = configs.get(plan) || configs.get("starter")!;
    return config.limits[resource] ?? 0;
  }

  /**
   * Check if plan has access to a feature
   */
  async hasPlanAccess(
    plan: SubscriptionPlan,
    feature: FeatureType,
  ): Promise<boolean> {
    const configs = await this.loadPlanConfigs();
    const config = configs.get(plan) || configs.get("starter")!;
    return config.features[feature] ?? false;
  }

  /**
   * Get the minimum plan required for a feature
   */
  async getRequiredPlan(feature: FeatureType): Promise<SubscriptionPlan> {
    const configs = await this.loadPlanConfigs();

    // Check in order: starter, plus, pro
    for (const plan of ["starter", "plus", "pro"] as SubscriptionPlan[]) {
      const config = configs.get(plan);
      if (config?.features[feature]) {
        return plan;
      }
    }

    return "pro"; // Default to highest tier if not found
  }

  /**
   * Count resources for a business
   */
  async countResources(
    businessId: string,
    resource: LimitResource,
  ): Promise<number> {
    let count = 0;

    switch (resource) {
      case "publications": {
        const { count: pubCount } = await this.supabase
          .from("publications")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);
        count = pubCount || 0;
        break;
      }

      case "sessions": {
        // Session limits are monthly and apply to circle session occurrences
        // scheduled in the current calendar month.
        const { data: circles } = await this.supabase
          .from("circles")
          .select("id")
          .eq("business_id", businessId)
          .is("deleted_at", null);

        if (circles && circles.length > 0) {
          const circleIds = circles.map((c) => c.id);

          const startOfMonth = new Date();
          startOfMonth.setUTCDate(1);
          startOfMonth.setUTCHours(0, 0, 0, 0);

          const startOfNextMonth = new Date(startOfMonth);
          startOfNextMonth.setUTCMonth(startOfNextMonth.getUTCMonth() + 1);

          const { count: sessCount } = await this.supabase
            .from("circle_sessions")
            .select("*", { count: "exact", head: true })
            .in("circle_id", circleIds)
            .gte("start_datetime", startOfMonth.toISOString())
            .lt("start_datetime", startOfNextMonth.toISOString());

          count = sessCount || 0;
        } else {
          count = 0;
        }
        break;
      }

      case "products": {
        // Product limits are applied to free products only (price <= 0).
        // Paid products are intentionally unlimited across plans.
        const { data: stores } = await this.supabase
          .from("stores")
          .select("id")
          .eq("business_id", businessId);

        if (stores && stores.length > 0) {
          const storeIds = stores.map((s) => s.id);
          const { count: prodCount } = await this.supabase
            .from("products")
            .select("id", { count: "exact", head: true })
            .in("store_id", storeIds)
            .eq("is_sellable", true)
            .lte("price", 0);
          count = prodCount || 0;
        }
        break;
      }

      case "website_pages": {
        const { count: pageCount } = await this.supabase
          .from("websites")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);
        count = pageCount || 0;
        break;
      }

      case "crm_contacts": {
        const { count: contactCount } = await this.supabase
          .from("crm_contacts_unified")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);
        count = contactCount || 0;
        break;
      }

      case "team_members": {
        const { count: memberCount } = await this.supabase
          .from("memberships")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId)
          .eq("status", "active");
        count = memberCount || 0;
        break;
      }

      case "segments": {
        const { count: segCount } = await this.supabase
          .from("segments")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId);
        count = segCount || 0;
        break;
      }

      case "emails_per_month": {
        // Count emails sent this month
        const startOfMonth = new Date();
        startOfMonth.setDate(1);
        startOfMonth.setHours(0, 0, 0, 0);

        const { data: campaigns } = await this.supabase
          .from("campaigns")
          .select("metrics, status")
          .eq("business_id", businessId)
          .gte("sent_at", startOfMonth.toISOString());

        count = (campaigns || []).reduce((acc, c) => {
          if (c.status === "sent") {
            return acc + (c.metrics?.sent || 0);
          }
          return acc;
        }, 0);
        break;
      }

      case "forms": {
        const { count: formCount } = await this.supabase
          .from("hilaq_forms")
          .select("*", { count: "exact", head: true })
          .eq("business_id", businessId)
          .is("deleted_at", null);
        count = formCount || 0;
        break;
      }
    }

    return count;
  }

  /**
   * Check if business can create more of a resource (Redis-cached, 60s TTL)
   */
  async canCreate(
    businessId: string,
    resource: LimitResource,
  ): Promise<{ allowed: boolean; used: number; limit: number | "unlimited" }> {
    const cacheKey = `can_create:${businessId}:${resource}`;
    const cached = await cacheGet<{ allowed: boolean; used: number; limit: number | "unlimited" }>(cacheKey);
    if (cached) return cached;

    const { data: business } = await this.supabase
      .from("businesses")
      .select("subscription_plan")
      .eq("id", businessId)
      .single();

    const plan = (business?.subscription_plan || "starter") as SubscriptionPlan;
    const limit = await this.getPlanLimit(plan, resource);
    const used = await this.countResources(businessId, resource);

    const result = limit === "unlimited"
      ? { allowed: true, used, limit }
      : { allowed: used < limit, used, limit };

    await cacheSet(cacheKey, result, CAN_CREATE_TTL);
    return result;
  }

  /**
   * Get full usage report for a business
   */
  async getUsageReport(businessId: string): Promise<UsageReport> {
    // Get business plan
    const { data: business } = await this.supabase
      .from("businesses")
      .select("subscription_plan")
      .eq("id", businessId)
      .single();

    const plan = (business?.subscription_plan || "starter") as SubscriptionPlan;
    const configs = await this.loadPlanConfigs();
    const config = configs.get(plan) || configs.get("starter")!;

    const resources: LimitResource[] = [
      "publications",
      "sessions",
      "products",
      "website_pages",
      "crm_contacts",
      "team_members",
      "segments",
      "emails_per_month",
      "forms",
    ];

    const usage: Partial<UsageReport> = {};

    for (const resource of resources) {
      const used = await this.countResources(businessId, resource);
      const limit = config.limits[resource];
      usage[resource] = { used, limit };
    }

    return usage as UsageReport;
  }

  /**
   * Get plan config
   */
  async getPlanConfig(plan: SubscriptionPlan): Promise<PlanConfig | null> {
    const configs = await this.loadPlanConfigs();
    return configs.get(plan) || null;
  }

  /**
   * Clear plan configs cache (call when plan_limits table changes)
   */
  async clearCache(): Promise<void> {
    const { cacheDel } = await import("../config/redis");
    await cacheDel(PLAN_CONFIGS_CACHE_KEY);
  }

  /**
   * Get extended usage report with resources and features (for frontend gating)
   */
  async getExtendedUsageReport(businessId: string): Promise<{
    plan: SubscriptionPlan;
    resources: Record<
      string,
      {
        used: number;
        limit: number | "unlimited";
        available: number | "unlimited";
      }
    >;
    features: PlanFeatures;
  }> {
    // Get business plan
    const { data: business } = await this.supabase
      .from("businesses")
      .select("subscription_plan")
      .eq("id", businessId)
      .single();

    const plan = (business?.subscription_plan || "starter") as SubscriptionPlan;
    const configs = await this.loadPlanConfigs();
    const config = configs.get(plan) || configs.get("starter")!;

    const resourceTypes: LimitResource[] = [
      "publications",
      "sessions",
      "products",
      "website_pages",
      "crm_contacts",
      "team_members",
      "segments",
      "emails_per_month",
      "forms",
    ];

    const resources: Record<
      string,
      {
        used: number;
        limit: number | "unlimited";
        available: number | "unlimited";
      }
    > = {};

    for (const resource of resourceTypes) {
      const used = await this.countResources(businessId, resource);
      const limit = config.limits[resource];
      const available =
        limit === "unlimited" ? "unlimited" : Math.max(0, limit - used);
      resources[resource] = { used, limit, available };
    }

    return {
      plan,
      resources,
      features: config.features,
    };
  }
}

// Singleton instance
export const planLimitsService = new PlanLimitsService();
