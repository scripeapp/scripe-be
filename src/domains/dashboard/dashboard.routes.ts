import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";

export function createDashboardRouter(): Router {
  const router = Router();
  const controller = new DashboardController(new DashboardService(getDatabase()));

  // Auth is applied per-route (not via a broad /api/store prefix) so it never
  // shadows sibling public routes like /api/store/bookings/reserve.
  router.get("/api/dashboard/stats", requireAuth, controller.stats);
  router.get("/api/store/analytics", requireAuth, controller.storeAnalytics);
  router.get("/api/store/pos/analytics", requireAuth, controller.posAnalytics);

  return router;
}
