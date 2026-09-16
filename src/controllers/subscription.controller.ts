/**
 * Subscription Controller
 * Handles membership subscription endpoints
 */

import { Request, Response } from "express";
import { SubscriptionService } from "../services/subscription.service";
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";

class SubscriptionController {
  /**
   * Get user's subscriptions
   * GET /api/subscriptions/my
   */
  async getMySubscriptions(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscriptions = await service.getUserSubscriptions(authReq.user_id);

      return ApiResponse.success(res, "Subscriptions retrieved successfully", subscriptions);
    } catch (error: any) {
      console.error("[SubscriptionController.getMySubscriptions]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get a single subscription
   * GET /api/subscriptions/:id
   */
  async getSubscription(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { id } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscription = await service.getSubscription(id, authReq.user_id);

      return ApiResponse.success(res, "Subscription retrieved successfully", subscription);
    } catch (error: any) {
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.getSubscription]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Cancel a subscription
   * POST /api/subscriptions/:id/cancel
   */
  async cancelSubscription(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { id } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscription = await service.cancelSubscription(id, authReq.user_id);

      return ApiResponse.success(res, "Subscription cancelled successfully", subscription);
    } catch (error: any) {
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.cancelSubscription]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Pause a subscription
   * POST /api/subscriptions/:id/pause
   */
  async pauseSubscription(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { id } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscription = await service.pauseSubscription(id, authReq.user_id);

      return ApiResponse.success(res, "Subscription paused successfully", subscription);
    } catch (error: any) {
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.pauseSubscription]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Resume a paused subscription
   * POST /api/subscriptions/:id/resume
   */
  async resumeSubscription(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { id } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscription = await service.resumeSubscription(id, authReq.user_id);

      return ApiResponse.success(res, "Subscription resumed successfully", subscription);
    } catch (error: any) {
      if (error.statusCode === 400) return ApiResponse.badRequest(res, error.message);
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.resumeSubscription]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Check if user has active subscription
   * GET /api/subscriptions/check/:productId
   */
  async checkAccess(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { productId } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.success(res, "Access check complete", { hasAccess: false });
      }

      const service = new SubscriptionService(authReq.supabase);
      const hasAccess = await service.hasActiveSubscription(authReq.user_id, productId);

      return ApiResponse.success(res, "Access check complete", { hasAccess });
    } catch (error: any) {
      console.error("[SubscriptionController.checkAccess]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get membership content for a product
   * GET /api/subscriptions/content/:productId
   */
  async getMembershipContent(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { productId } = req.params;

      const service = new SubscriptionService(authReq.supabase);
      const content = await service.getMembershipContent(productId, authReq.user_id);

      return ApiResponse.success(res, "Content retrieved successfully", content);
    } catch (error: any) {
      console.error("[SubscriptionController.getMembershipContent]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  // ============================================================================
  // Store Owner Endpoints
  // ============================================================================

  /**
   * Get store subscriptions (for merchant dashboard)
   * GET /api/subscriptions/store?store_id=...&status=...
   */
  async getStoreSubscriptions(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { store_id, status } = req.query as { store_id: string; status?: string };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new SubscriptionService(authReq.supabase);
      const subscriptions = await service.getStoreSubscriptions(store_id, { status });

      return ApiResponse.success(res, "Store subscriptions retrieved", subscriptions);
    } catch (error: any) {
      console.error("[SubscriptionController.getStoreSubscriptions]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Create membership content
   * POST /api/subscriptions/content
   */
  async createContent(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { product_id, title, description, content, access_tier } = req.body;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      if (!product_id || !title) {
        return ApiResponse.badRequest(res, "product_id and title are required");
      }

      const service = new SubscriptionService(authReq.supabase);

      // Verify merchant access
      const hasAccess = await service.validateProductMerchantAccess(authReq.user_id, product_id);
      if (!hasAccess) {
        return ApiResponse.forbidden(res, "Only the store owner can create membership content");
      }

      const newContent = await service.createContent(product_id, {
        title,
        description,
        content,
        access_tier,
      });

      return ApiResponse.success(res, "Content created successfully", newContent);
    } catch (error: any) {
      console.error("[SubscriptionController.createContent]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Update membership content
   * PATCH /api/subscriptions/content/:contentId
   */
  async updateContent(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { contentId } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);

      // Verify merchant access
      await service.validateContentMerchantAccess(authReq.user_id, contentId);

      const content = await service.updateContent(contentId, req.body);

      return ApiResponse.success(res, "Content updated successfully", content);
    } catch (error: any) {
      if (error.statusCode === 403) return ApiResponse.forbidden(res, error.message);
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.updateContent]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Delete membership content
   * DELETE /api/subscriptions/content/:contentId
   */
  async deleteContent(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { contentId } = req.params;

      if (!authReq.user_id) {
        return ApiResponse.unauthorized(res, "Authentication required");
      }

      const service = new SubscriptionService(authReq.supabase);

      // Verify merchant access
      await service.validateContentMerchantAccess(authReq.user_id, contentId);

      await service.deleteContent(contentId);

      return ApiResponse.success(res, "Content deleted successfully");
    } catch (error: any) {
      if (error.statusCode === 403) return ApiResponse.forbidden(res, error.message);
      if (error.statusCode === 404) return ApiResponse.notFound(res, error.message);
      console.error("[SubscriptionController.deleteContent]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get subscribers for a product
   * GET /api/store/product/:productId/subscribers
   */
  async getProductSubscribers(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { productId } = req.params;
      const { status } = req.query;

      const service = new SubscriptionService(authReq.supabase);
      const subscribers = await service.getProductSubscribers(productId, {
        status: status as string,
      });

      return ApiResponse.success(res, "Subscribers retrieved successfully", subscribers);
    } catch (error: any) {
      console.error("[SubscriptionController.getProductSubscribers]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export const subscriptionController = new SubscriptionController();
