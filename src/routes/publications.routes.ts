import { Router } from "express";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import {
  createPublication,
  deletePublication,
  getPublicationPosts,
  getAllPublications,
  getMyPublications,
  updatePublication,
  incrementPostViews,
  getPublicationDetail,
  updateMonetization,
  subscribeToPublication,
  getPublicationSubscription,
  cancelSubscription,
  getUserSubscriptions,
} from "../controllers/pubs.controller";
import { requirePermission } from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";
import { enforcePlanLimit } from "../middleware/plan-limits.middleware";
import multer from "multer";

const upload = multer({ storage: multer.memoryStorage() }); // Store file in memory temporarily

const router = Router();

// ============================================================================
// STATIC ROUTES (must come before dynamic /:id routes)
// ============================================================================

router.post(
  "/create",
  authenticateUser,
  requirePermission("publication.post.create"),
  enforcePlanLimit("publications"),
  withSupabase(createPublication),
);

// /all must come before /:id to avoid collision
router.get("/all", authenticateOptional, withSupabase(getAllPublications));

// Authenticated user's own publications only (no RPC, no subscription noise)
router.get("/mine", authenticateUser, withSupabase(getMyPublications));

// Get all subscriptions for current user (must come before /:id)
router.get(
  "/me/subscriptions",
  authenticateUser,
  withSupabase(getUserSubscriptions),
);

// Cancel a subscription (must come before /:id routes)
router.post(
  "/subscriptions/:id/cancel",
  authenticateUser,
  withSupabase(cancelSubscription),
);

router.post(
  "/posts/:id/view",
  authenticateOptional,
  withSupabase(incrementPostViews),
);

router.put(
  "/update/:id",
  upload.single("imageFile"),
  authenticateUser,
  requirePermission("publication.settings.update"),
  withSupabase(updatePublication),
);

// ============================================================================
// DYNAMIC /:id ROUTES
// ============================================================================

// Update monetization settings (owner only)
router.patch(
  "/:id/monetization",
  authenticateUser,
  // Permission check is handled in controller to support both user and business context
  withSupabase(updateMonetization),
);

// Subscribe to a publication
router.post(
  "/:id/subscribe",
  authenticateUser,
  withSupabase(subscribeToPublication),
);

// Get current user's subscription to a publication
router.get(
  "/:id/subscription",
  authenticateUser,
  withSupabase(getPublicationSubscription),
);

router.get(
  "/:id/posts",
  authenticateOptional,
  withSupabase(getPublicationPosts),
);

router.get("/:id", authenticateOptional, withSupabase(getPublicationDetail));

router.delete(
  "/:id",
  authenticateUser,
  requirePermission("publication.post.delete"),
  withSupabase(deletePublication),
);

export default router;
