import express from "express";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import {
  addPartner,
  updatePartnerStatus,
  listAllPartners,
  getMyPartnerProfile,
  checkPartnerStatus,
  getPartnerDashboard,
  getDownline,
  getReferralDetail,
  trackClick,
} from "../controllers/partner.controller";

const router = express.Router();

// ============================================================================
// PUBLIC ROUTES
// ============================================================================

// Track referral click (redirects to homepage with ref code)
router.get("/track/:code", trackClick);

// ============================================================================
// PARTNER ROUTES (require auth)
// ============================================================================

// Check if current user is a partner
router.get("/check", authenticateOptional, withSupabase(checkPartnerStatus));

// Get my partner profile
router.get("/me", authenticateUser, withSupabase(getMyPartnerProfile));

// Get partner dashboard stats
router.get(
  "/me/dashboard",
  authenticateUser,
  withSupabase(getPartnerDashboard),
);

// Get downline (referred users)
router.get("/me/downline", authenticateUser, withSupabase(getDownline));

// Get referral detail (user + commissions)
router.get(
  "/me/downline/:refId",
  authenticateUser,
  withSupabase(getReferralDetail),
);

// ============================================================================
// ADMIN ROUTES
// ============================================================================

// List all partners (admin only)
router.get("/all", authenticateUser, withSupabase(listAllPartners));

// Add a new partner (admin only)
router.post("/", authenticateUser, withSupabase(addPartner));

// Update partner status (admin only)
router.patch(
  "/:id/status",
  authenticateUser,
  withSupabase(updatePartnerStatus),
);

export default router;
