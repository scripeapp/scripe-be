/**
 * Plan Limits Middleware
 * Enforces resource creation limits based on business subscription plan
 */

import { Request, Response, NextFunction } from "express";
import { PlanLimitsService } from "../services/plan-limits.service";
import { LimitResource } from "../types/subscription";
import { upgradeSignalsService } from "../services/upgrade-signals.service";

/**
 * Middleware to enforce plan limits on resource creation
 * @param resource - The resource type being created (e.g., 'publications', 'products')
 */
export function enforcePlanLimit(resource: LimitResource) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const supabaseReq = req as any;
      const businessId =
        req.params.businessId || req.body.business_id || supabaseReq.businessId;

      if (!businessId) {
        return res.status(400).json({
          success: false,
          error: "business_id_required",
          message: "Business ID is required",
        });
      }

      const planLimitsService = new PlanLimitsService(supabaseReq.supabase);
      const { allowed, used, limit } = await planLimitsService.canCreate(businessId, resource);

      if (!allowed) {
        // Get business plan for error message
        const { data: business } = await supabaseReq.supabase
          .from("businesses")
          .select("subscription_plan")
          .eq("id", businessId)
          .single();

        const plan = business?.subscription_plan || "starter";
        const resourceLabel = resource;

        // Fire-and-forget: record this as an upgrade signal
        upgradeSignalsService
          .recordLimitHit(
            supabaseReq.supabase,
            businessId,
            resource,
            plan,
            typeof limit === "number" ? limit : 0,
            used,
          )
          .catch((err) =>
            console.error("[UpgradeSignals] recordLimitHit error:", err),
          );

        return res.status(403).json({
          success: false,
          error: "limit_reached",
          message: `Your ${plan} plan allows ${limit} ${resourceLabel}. You've used ${used}.`,
          upgrade_required: true,
          resource,
          limit,
          used,
          plan,
        });
      }

      next();
    } catch (error: any) {
      console.error("[enforcePlanLimit] Error:", error);
      return res.status(500).json({
        success: false,
        error: "limit_check_failed",
        message: error.message || "Failed to check plan limits",
      });
    }
  };
}

/**
 * Helper to get limit for a resource (for use in services)
 */
export async function getPlanLimitForBusiness(
  supabase: any,
  businessId: string,
  resource: LimitResource
): Promise<{ limit: number | "unlimited"; used: number; allowed: boolean }> {
  const planLimitsService = new PlanLimitsService(supabase);
  return planLimitsService.canCreate(businessId, resource);
}
