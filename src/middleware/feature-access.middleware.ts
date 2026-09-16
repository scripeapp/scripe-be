/**
 * Feature Access Middleware
 * Gates features based on business subscription plan
 */

import { Response, NextFunction } from "express";
import { SupabaseRequest } from "../types/http";
import {
  PlanLimitsService,
  planLimitsService,
} from "../services/plan-limits.service";
import { FeatureType, SubscriptionPlan } from "../types/subscription";

/**
 * Middleware to require access to a specific feature
 * @param feature - The feature being accessed (e.g., 'courses', 'custom_domain')
 */
export function requireFeature(feature: FeatureType) {
  return async (req: any, res: Response, next: NextFunction) => {
    try {
      const businessId =
        req.params.businessId || req.body.business_id || req.businessId;

      if (!businessId) {
        return res.status(400).json({
          success: false,
          error: "business_id_required",
          message: "Business ID is required",
        });
      }

      const supabase = req.supabase;
      if (!supabase) {
        return res.status(401).json({
          success: false,
          error: "unauthorized",
          message: "Authentication required",
        });
      }

      // Get business plan
      const { data: business } = await supabase
        .from("businesses")
        .select("subscription_plan")
        .eq("id", businessId)
        .single();

      const plan = (business?.subscription_plan ||
        "starter") as SubscriptionPlan;

      // Check if plan has access to feature
      const hasAccess = await planLimitsService.hasPlanAccess(plan, feature);

      if (!hasAccess) {
        const requiredPlan = await planLimitsService.getRequiredPlan(feature);

        return res.status(403).json({
          success: false,
          error: "upgrade_required",
          message: `This feature requires a ${requiredPlan} plan`,
          feature,
          current_plan: plan,
          required_plan: requiredPlan,
        });
      }

      next();
    } catch (error: any) {
      console.error("[requireFeature] Error:", error);
      return res.status(500).json({
        success: false,
        error: "feature_check_failed",
        message: error.message || "Failed to check feature access",
      });
    }
  };
}

/**
 * Helper to check if business has access to a feature (for use in services)
 */
export async function businessHasFeature(
  supabase: any,
  businessId: string,
  feature: FeatureType,
): Promise<boolean> {
  const { data: business } = await supabase
    .from("businesses")
    .select("subscription_plan")
    .eq("id", businessId)
    .single();

  const plan = (business?.subscription_plan || "starter") as SubscriptionPlan;
  return planLimitsService.hasPlanAccess(plan, feature);
}

/**
 * Map of features to their required minimum plan
 */
export const FEATURE_PLAN_MAP: Record<FeatureType, SubscriptionPlan> = {
  events: "starter",
  store: "starter",
  digital_downloads: "starter",
  courses: "pro",
  memberships: "pro",
  services_bookings: "plus",
  advanced_page_builder: "plus",
  custom_domain: "pro",
  custom_roles: "pro",
  email_support: "plus",
  priority_support: "pro",
  advanced_analytics: "pro",
  ai_assistant: "plus",
  forms: "starter",
};
