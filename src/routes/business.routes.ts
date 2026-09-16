import { Router } from "express";
import { BusinessController } from "../controllers/business.controller";
import { BusinessSubscriptionController } from "../controllers/business-subscription.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import {
  requirePermission,
  requireBusinessOwner,
} from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";
import upload from "../middleware/upload.middleware";

const router = Router();

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

// Get business by slug (public)
router.get("/slug/:slug", BusinessController.getBusinessBySlug);

// Get enriched public business profile — events, circles, products, publication
router.get("/public/:slug", BusinessController.getBusinessPublicProfile);

// Get all business categories (public)
router.get("/categories", BusinessController.getBusinessCategories);

// ============================================================================
// PROTECTED ROUTES
// ============================================================================

// Apply authentication to all following routes
router.use(authenticateUser);

// Get user's businesses
router.get("/me/businesses", BusinessController.getMyBusinesses);

// Check if user has businesses
router.get("/check", BusinessController.checkHasBusinesses);

// Create a new business
router.post("/", BusinessController.createBusiness);

// Get business by ID
// Get business by ID
router.get("/:businessId", BusinessController.getBusiness);

// Get business branding
router.get("/:businessId/branding", BusinessController.getBranding);

// Update business
router.patch(
  "/:businessId",
  requirePermission("admin.business.update"),
  BusinessController.updateBusiness,
);

// Delete business (owner only)
router.delete(
  "/:businessId",
  requireBusinessOwner(),
  BusinessController.deleteBusiness,
);

// ============================================================================
// SUBSCRIPTION ROUTES
// ============================================================================

// Get subscription details
router.get(
  "/:businessId/subscription",
  withSupabase(BusinessSubscriptionController.getSubscription),
);

// Get usage counts vs limits
router.get(
  "/:businessId/subscription/usage",
  withSupabase(BusinessSubscriptionController.getUsage),
);

// Get payment history (owner only)
router.get(
  "/:businessId/subscription/invoices",
  requireBusinessOwner(),
  withSupabase(BusinessSubscriptionController.getInvoices),
);

// Initiate subscription (owner only)
router.post(
  "/:businessId/subscription/initiate",
  requireBusinessOwner(),
  withSupabase(BusinessSubscriptionController.initiateSubscription),
);

// Cancel subscription (owner only)
router.post(
  "/:businessId/subscription/cancel",
  requireBusinessOwner(),
  withSupabase(BusinessSubscriptionController.cancelSubscription),
);

// Change plan (owner only)
router.post(
  "/:businessId/subscription/change-plan",
  requireBusinessOwner(),
  withSupabase(BusinessSubscriptionController.changePlan),
);

// ============================================================================
// SUBACCOUNT ROUTES (for split payments)
// ============================================================================

// Get subaccount settings
router.get("/:businessId/subaccount", BusinessController.getSubaccount);

router.post(
  "/:businessId/subaccount/verification/request",
  requireBusinessOwner(),
  BusinessController.requestSubaccountChangeVerification,
);

// Create/update subaccount (owner only)
router.put(
  "/:businessId/subaccount",
  requireBusinessOwner(),
  BusinessController.updateSubaccount,
);

// Query-param style routes (for frontend compatibility)
// GET /api/business/subaccount?business_id=xxx
router.get("/subaccount", BusinessController.getSubaccountByQuery);

// PATCH /api/business/subaccount
router.patch("/subaccount", BusinessController.updateSubaccountByQuery);

// ============================================================================
// STORAGE ROUTES
// ============================================================================
router.post(
  "/upload/image",
  upload.single("file"),
  requirePermission("admin.business.update"),
  BusinessController.uploadBusinessImage,
);

export const businessRoutes = router;
