import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PaymentsController } from "./payments.controller.js";
import { PaymentsService } from "./payments.service.js";

export function createPaymentsRouter(): Router {
  const router = Router();
  const controller = new PaymentsController(new PaymentsService(getDatabase()));
  const base = "/api/businesses/:businessId/payments";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.record);
  router.post(`${base}/checkout`, controller.initiateCheckout);
  router.post(`${base}/checkout/:reference/verify`, controller.verifyCheckout);
  router.get(`${base}/:paymentId`, controller.get);

  return router;
}
