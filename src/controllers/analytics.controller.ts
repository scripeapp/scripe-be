import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { AnalyticsService } from "../services/analytics.service";

export class AnalyticsController {
  /**
   * Track a user event (public endpoint)
   * POST /api/analytics/track
   */
  async trackEvent(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const {
        event_type,
        resource_id,
        resource_type,
        store_id,
        business_id,
        session_id,
        metadata,
      } = req.body;

      if (!event_type) {
        return ApiResponse.badRequest(res, "event_type is required");
      }

      const service = new AnalyticsService(req.supabase);

      // Fire and forget - don't await tracking to keep response fast
      service
        .trackEvent({
          event_type,
          resource_id,
          resource_type,
          store_id,
          business_id,
          session_id,
          user_id: req.user_id, // Optional, only if logged in
          metadata,
        })
        .catch((err) => console.error("Async tracking error:", err));

      return ApiResponse.success(res, "Event tracked");
    } catch (err: any) {
      console.error("Track Event Error:", err);
      // Don't fail the request if tracking fails
      return ApiResponse.success(res, "Event tracked (fallback)");
    }
  }

  /**
   * Get store analytics dashboard data
   * GET /api/analytics/store/:storeId
   */
  async getStoreAnalytics(
    req: SupabaseRequest,
    res: Response,
  ): Promise<Response> {
    try {
      const { storeId } = req.params;
      const { range } = req.query;

      if (!storeId) {
        return ApiResponse.badRequest(res, "storeId is required");
      }

      const service = new AnalyticsService(req.supabase);
      const data = await service.getStoreOverview(
        storeId,
        (range as "7d" | "30d" | "all") || "30d",
      );

      return ApiResponse.success(res, "Analytics retrieved", data);
    } catch (err: any) {
      console.error("Get Analytics Error:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }
  async getStoreEvents(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const { storeId } = req.params;
      const { page = 1, limit = 20 } = req.query;

      const service = new AnalyticsService(req.supabase);
      const data = await service.getStoreEvents(
        storeId,
        Number(page),
        Number(limit),
      );

      return ApiResponse.success(res, "Events retrieved", data);
    } catch (err: any) {
      return ApiResponse.serverError(res, err.message);
    }
  }
}
