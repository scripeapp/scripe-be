import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { clientIp, rateLimit } from "../../middleware/rate-limit.js";
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
  // Tokens are unguessable, but the per-IP limit still stops link scanning,
  // and the per-token limit stops one link from opening checkouts in a loop.
  router.get(
    "/api/invoices/public/:token",
    rateLimit({ name: "invoice-view-ip", windowSeconds: 60, max: 60, key: clientIp }),
    controller.getPublic,
  );
  router.post(
    "/api/invoices/public/:token/pay",
    rateLimit(
      { name: "invoice-pay-ip", windowSeconds: 60, max: 10, key: clientIp },
      { name: "invoice-pay-token", windowSeconds: 60, max: 5, key: (request) => (typeof request.params.token === "string" ? request.params.token : null) },
    ),
    controller.payPublic,
  );
  router.post(
    "/api/invoices/public/:token/transfer-reported",
    rateLimit(
      { name: "invoice-transfer-ip", windowSeconds: 3600, max: 20, key: clientIp },
      { name: "invoice-transfer-token", windowSeconds: 3600, max: 5, key: (request) => (typeof request.params.token === "string" ? request.params.token : null) },
    ),
    controller.reportTransferPublic,
  );

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
  router.post(`${base}/:invoiceId/duplicate`, controller.duplicate);

  return router;
}
