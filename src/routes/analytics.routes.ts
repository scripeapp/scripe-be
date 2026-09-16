import { Router } from "express";
import { AnalyticsController } from "../controllers/analytics.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";

const router = Router();
const controller = new AnalyticsController();

// Public Tracking (or authenticated if needed, but usually public for clicks)
// Best practice: Rate limit this endpoint heavily
router.post("/track", (req, res) => controller.trackEvent(req as any, res));

// Admin Dashboard - Protected
router.get("/store/:storeId", authenticateUser, (req, res) =>
  controller.getStoreAnalytics(req as any, res),
);

router.get("/store/:storeId/events", authenticateUser, (req, res) =>
  controller.getStoreEvents(req as any, res),
);

export default router;
