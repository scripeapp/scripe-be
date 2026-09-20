import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PromotionsController } from "./promotions.controller.js";
import { PromotionsService } from "./promotions.service.js";

export function createPromotionsRouter(): Router {
  const router = Router();
  const controller = new PromotionsController(new PromotionsService(getDatabase()));
  const base = "/api/businesses/:businessId/discounts";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:discountId`, controller.get);
  router.patch(`${base}/:discountId`, controller.update);
  router.delete(`${base}/:discountId`, controller.archive);
  router.post(`${base}/evaluate`, controller.evaluate);

  return router;
}
