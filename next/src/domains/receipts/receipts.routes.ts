import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ReceiptsController } from "./receipts.controller.js";
import { ReceiptsService } from "./receipts.service.js";

export function createReceiptsRouter(): Router {
  const router = Router();
  const controller = new ReceiptsController(new ReceiptsService(getDatabase()));
  const base = "/api/businesses/:businessId/receipts";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.get(`${base}/:documentId`, controller.get);
  router.get("/api/businesses/:businessId/orders/:orderId/receipt", requireAuth, controller.getForOrder);

  return router;
}
