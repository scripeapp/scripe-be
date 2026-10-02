import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PaymentsService } from "../payments/payments.service.js";
import { InvoicesController } from "./invoices.controller.js";
import { InvoicesService } from "./invoices.service.js";

export function createInvoicesRouter(): Router {
  const router = Router();
  const db = getDatabase();
  const paymentsService = new PaymentsService(db);
  const service = new InvoicesService(db, paymentsService);
  const controller = new InvoicesController(service);

  // Public routes for viewing and paying invoice (no login required)
  router.get("/api/invoices/public/:token", controller.getPublic);
  router.post("/api/invoices/public/:token/pay", controller.payPublic);

  // Authenticated business-scoped routes
  const base = "/api/businesses/:businessId/invoices";
  router.use(base, requireAuth);

  router.get(base, controller.list);
  router.get(`${base}/metrics`, controller.getMetrics);
  router.get(`${base}/next-number`, controller.getNextNumber);
  router.post(base, controller.createDraft);
  router.get(`${base}/:invoiceId`, controller.get);
  router.patch(`${base}/:invoiceId`, controller.updateDraft);
  router.delete(`${base}/:invoiceId`, controller.deleteDraft);
  router.post(`${base}/:invoiceId/send`, controller.send);
  router.post(`${base}/:invoiceId/payments`, controller.recordPayment);
  router.post(`${base}/:invoiceId/remind`, controller.sendReminder);
  router.post(`${base}/:invoiceId/void`, controller.void);

  return router;
}
