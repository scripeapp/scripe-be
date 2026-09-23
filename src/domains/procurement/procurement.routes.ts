import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ProcurementController } from "./procurement.controller.js";
import { ProcurementService } from "./procurement.service.js";

export function createProcurementRouter(): Router {
  const router = Router();
  const controller = new ProcurementController(new ProcurementService(getDatabase()));
  const base = "/api/businesses/:businessId/procurement";
  router.use(base, requireAuth);

  router.get(`${base}/purchase-orders`, controller.listOrders);
  router.get(`${base}/purchase-orders/:orderId`, controller.getOrder);
  router.post(`${base}/purchase-orders`, controller.createOrder);
  router.patch(`${base}/purchase-orders/:orderId`, controller.updateOrder);
  router.post(`${base}/purchase-orders/:orderId/send`, controller.sendOrder);
  router.post(`${base}/goods-receipts`, controller.receive);
  router.get(`${base}/goods-receipts`, controller.listReceipts);

  return router;
}
