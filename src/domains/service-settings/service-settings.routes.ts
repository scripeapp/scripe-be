import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ServiceSettingsController } from "./service-settings.controller.js";
import { ServiceSettingsService } from "./service-settings.service.js";

export function createServiceSettingsRouter(): Router {
  const router = Router();
  const controller = new ServiceSettingsController(new ServiceSettingsService(getDatabase()));
  const base = "/api/businesses/:businessId/products/:productId/service-settings";

  router.use(base, requireAuth);
  router.get(base, controller.get);
  router.put(base, controller.upsert);

  return router;
}
