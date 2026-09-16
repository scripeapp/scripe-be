import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import {
  getIntegrations,
  getGoogleConnectUrl,
  handleGoogleCallback,
  disconnectGoogleCalendar,
} from "../controllers/integrations.controller";

const router = Router();

// Get all integration statuses
router.get("/", authenticateUser, withSupabase(getIntegrations));

// Google Calendar OAuth
router.get(
  "/google-calendar/connect",
  authenticateUser,
  withSupabase(getGoogleConnectUrl)
);

// OAuth callback — no auth middleware (Google redirects here without a token)
router.get("/google-calendar/callback", withSupabase(handleGoogleCallback));

// Disconnect Google Calendar
router.delete(
  "/google-calendar",
  authenticateUser,
  withSupabase(disconnectGoogleCalendar)
);

export default router;
