/**
 * Business Subscription Controller
 * Handles subscription management endpoints
 */

import { Response } from "express";
import { BusinessSubscriptionService } from "../services/business-subscription.service";
import { SupabaseRequest } from "../types/http";

export class BusinessSubscriptionController {
  /**
   * GET /businesses/:businessId/subscription
   * Get subscription details for a business
   */
  static async getSubscription(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const service = new BusinessSubscriptionService(req.supabase);

      const subscription = await service.getSubscription(businessId);

      return res.json({ success: true, data: subscription });
    } catch (error: any) {
      console.error("[getSubscription] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch subscription",
      });
    }
  }

  /**
   * POST /businesses/:businessId/subscription/initiate
   * Start a new subscription (returns Paystack payment URL)
   */
  static async initiateSubscription(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const { plan, callback_url } = req.body;
      const userId = req.user_id!;

      if (!plan || !["plus", "pro"].includes(plan)) {
        return res.status(400).json({
          success: false,
          error: "Invalid plan. Must be 'plus' or 'pro'",
        });
      }

      // Get user email
      const { data: user } = await req
        .supabase!.from("users")
        .select("email")
        .eq("id", userId)
        .single();

      if (!user?.email) {
        return res.status(400).json({
          success: false,
          error: "User email not found",
        });
      }

      const service = new BusinessSubscriptionService(req.supabase);
      const result = await service.initiateSubscription(
        businessId,
        plan,
        user.email,
        userId,
        callback_url,
      );

      return res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("[initiateSubscription] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to initiate subscription",
      });
    }
  }

  /**
   * POST /businesses/:businessId/subscription/cancel
   * Cancel a business subscription
   */
  static async cancelSubscription(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const service = new BusinessSubscriptionService(req.supabase);

      await service.cancelSubscription(businessId);

      return res.json({
        success: true,
        message: "Subscription cancelled. Access continues until period end.",
      });
    } catch (error: any) {
      console.error("[cancelSubscription] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to cancel subscription",
      });
    }
  }

  /**
   * POST /businesses/:businessId/subscription/change-plan
   * Change subscription plan (upgrade/downgrade)
   */
  static async changePlan(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const { plan, callback_url } = req.body;
      const userId = req.user_id!;

      // Use plan (from body) as the new plan
      if (!plan || !["plus", "pro"].includes(plan)) {
        return res.status(400).json({
          success: false,
          error: "Invalid plan. Must be 'plus' or 'pro'",
        });
      }

      // Get user email
      const { data: user } = await req
        .supabase!.from("users")
        .select("email")
        .eq("id", userId)
        .single();

      if (!user?.email) {
        return res.status(400).json({
          success: false,
          error: "User email not found",
        });
      }

      const service = new BusinessSubscriptionService(req.supabase);
      const result = await service.changePlan(
        businessId,
        plan,
        user.email,
        userId,
        callback_url,
      );

      return res.json({ success: true, data: result });
    } catch (error: any) {
      console.error("[changePlan] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to change plan",
      });
    }
  }

  /**
   * GET /businesses/:businessId/subscription/usage
   * Get resource usage counts vs limits
   */
  static async getUsage(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const service = new BusinessSubscriptionService(req.supabase);

      const usage = await service.getUsage(businessId);

      return res.json({ success: true, data: usage });
    } catch (error: any) {
      console.error("[getUsage] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch usage",
      });
    }
  }

  /**
   * GET /businesses/:businessId/subscription/invoices
   * Get payment history
   */
  static async getInvoices(req: SupabaseRequest, res: Response) {
    try {
      const { businessId } = req.params;
      const service = new BusinessSubscriptionService(req.supabase);

      const invoices = await service.getInvoices(businessId);

      return res.json({ success: true, data: invoices });
    } catch (error: any) {
      console.error("[getInvoices] Error:", error);
      return res.status(error.statusCode || 500).json({
        success: false,
        error: error.message || "Failed to fetch invoices",
      });
    }
  }
}
