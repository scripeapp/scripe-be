import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { BusinessesController } from "./businesses.controller.js";
import { BusinessesService } from "./businesses.service.js";

export function createBusinessesRouter(): Router {
  const router = Router();
  const controller = new BusinessesController(new BusinessesService(getDatabase()));

  router.get("/api/businesses", requireAuth, controller.list);
  router.post("/api/businesses", requireAuth, controller.create);
  router.get("/api/businesses/:businessId", requireAuth, controller.get);
  router.patch("/api/businesses/:businessId", requireAuth, controller.update);
  router.delete("/api/businesses/:businessId", requireAuth, controller.archive);

  return router;
}
