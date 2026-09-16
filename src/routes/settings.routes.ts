import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import {
  changeTippingState,
  getTippingRequirements,
  updateMarketplaceVisibility,
  getNotificationPreferences,
  updateNotificationPreferences,
  getSecuritySettings,
  revokeSession,
  getPayoutPreferences,
  updatePayoutPreferences,
} from "../controllers/settings.controller";
import { withSupabase } from "../types/http";

const router = Router();

// Tipping
router.patch("/tipping", authenticateUser, withSupabase(changeTippingState));
router.get("/tipping-requirements", authenticateUser, withSupabase(getTippingRequirements));
router.patch("/marketplace-visibility", authenticateUser, withSupabase(updateMarketplaceVisibility));

// Notification Preferences
router.get("/notifications", authenticateUser, withSupabase(getNotificationPreferences));
router.patch("/notifications", authenticateUser, withSupabase(updateNotificationPreferences));

// Security Settings (Future-Ready)
router.get("/security", authenticateUser, withSupabase(getSecuritySettings));
router.delete("/security/sessions/:sessionId", authenticateUser, withSupabase(revokeSession));

// Wallet/Payout Preferences
router.get("/wallet/preferences", authenticateUser, withSupabase(getPayoutPreferences));
router.patch("/wallet/preferences", authenticateUser, withSupabase(updatePayoutPreferences));

export default router;
