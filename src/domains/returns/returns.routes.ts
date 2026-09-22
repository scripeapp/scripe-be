import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ReturnsController } from "./returns.controller.js";
import { ReturnsService } from "./returns.service.js";

export function createReturnsRouter(): Router {
  const router = Router();
  const controller = new ReturnsController(new ReturnsService(getDatabase()));
  const base = "/api/businesses/:businessId/returns";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:returnId`, controller.get);

  return router;
}
