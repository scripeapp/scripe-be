import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PaymentsService } from "../payments/payments.service.js";
import { PaylinksController } from "./paylinks.controller.js";
import { PaylinksService } from "./paylinks.service.js";

export function createPaylinksRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const paymentsService = new PaymentsService(db);
  const service = new PaylinksService(db, paymentsService);
  const controller = new PaylinksController(service);

  // Public unauthenticated routes for viewing and paying through links
  router.get("/api/public/paylinks/:slug", controller.getPublic);
  router.post("/api/public/paylinks/:slug/checkout", controller.checkoutPublic);
  router.get("/api/public/paylinks/checkout/:reference", controller.getCheckoutStatus);

  // Authenticated business-scoped routes
  const base = "/api/businesses/:businessId/paylinks";
  router.use(base, requireAuth);

  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:paylinkId`, controller.get);
  router.patch(`${base}/:paylinkId`, controller.update);
  router.delete(`${base}/:paylinkId`, controller.archive);
  router.get(`${base}/:paylinkId/payments`, controller.payments);

  return router;
}
