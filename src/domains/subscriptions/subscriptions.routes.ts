import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { SubscriptionsController } from "./subscriptions.controller.js";
import { SubscriptionsService } from "./subscriptions.service.js";

export function createSubscriptionsRouter(): Router {
  const router = Router();
  const controller = new SubscriptionsController(new SubscriptionsService(getDatabase()));

  router.get("/api/subscriptions/plans", requireAuth, controller.listPlans);

  const base = "/api/businesses/:businessId/subscription";
  router.use(base, requireAuth);
  router.get(base, controller.getSubscription);
  router.get(`${base}/usage`, controller.getUsage);
  router.get(`${base}/invoices`, controller.getInvoices);
  router.post(`${base}/initiate`, controller.initiateSubscription);
  router.post(`${base}/change-plan`, controller.initiateSubscription);
  router.post(`${base}/cancel`, controller.cancelSubscription);

  return router;
}
