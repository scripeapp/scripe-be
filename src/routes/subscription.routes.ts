/**
 * Subscription Routes
 * Endpoints for membership subscriptions
 */

import { Router } from "express";
import { authenticateUser, authenticateOptional } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";
import { subscriptionController } from "../controllers/subscription.controller";

const router = Router();

// ============================================================================
// User Subscription Endpoints (Auth Required)
// ============================================================================

// Get my subscriptions
router.get(
  "/my",
  authenticateUser,
  withSupabase(subscriptionController.getMySubscriptions.bind(subscriptionController))
);

// Check subscription access
router.get(
  "/check/:productId",
  authenticateOptional,
  withSupabase(subscriptionController.checkAccess.bind(subscriptionController))
);

// Get single subscription
router.get(
  "/:id",
  authenticateUser,
  withSupabase(subscriptionController.getSubscription.bind(subscriptionController))
);

// Cancel subscription
router.post(
  "/:id/cancel",
  authenticateUser,
  withSupabase(subscriptionController.cancelSubscription.bind(subscriptionController))
);

// Pause subscription
router.post(
  "/:id/pause",
  authenticateUser,
  withSupabase(subscriptionController.pauseSubscription.bind(subscriptionController))
);

// Resume subscription
router.post(
  "/:id/resume",
  authenticateUser,
  withSupabase(subscriptionController.resumeSubscription.bind(subscriptionController))
);

// ============================================================================
// Membership Content (Mixed Auth)
// ============================================================================

// Get membership content (returns full or preview based on subscription)
router.get(
  "/content/:productId",
  authenticateOptional,
  withSupabase(subscriptionController.getMembershipContent.bind(subscriptionController))
);

// ============================================================================
// Store Owner Endpoints (Requires Permission)
// ============================================================================

// Get store subscriptions
router.get(
  "/store",
  authenticateUser,
  requirePermission("store.order.read"),
  withSupabase(subscriptionController.getStoreSubscriptions.bind(subscriptionController))
);

// Create membership content
router.post(
  "/content",
  authenticateUser,
  requirePermission("store.product.update"),
  withSupabase(subscriptionController.createContent.bind(subscriptionController))
);

// Update membership content
router.patch(
  "/content/:contentId",
  authenticateUser,
  requirePermission("store.product.update"),
  withSupabase(subscriptionController.updateContent.bind(subscriptionController))
);

// Delete membership content
router.delete(
  "/content/:contentId",
  authenticateUser,
  requirePermission("store.product.update"),
  withSupabase(subscriptionController.deleteContent.bind(subscriptionController))
);

export default router;
