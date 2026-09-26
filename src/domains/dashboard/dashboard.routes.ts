import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";

export function createDashboardRouter(): Router {
  const router = Router();
  const controller = new DashboardController(new DashboardService(getDatabase()));
  const base = "/api/dashboard";

  router.use(base, requireAuth);
  router.get(`${base}/stats`, controller.stats);

  return router;
}
