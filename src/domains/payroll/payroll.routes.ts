import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { TransfersService } from "../transfers/transfers.service.js";
import { PayrollController } from "./payroll.controller.js";
import { PayrollService } from "./payroll.service.js";

export function createPayrollRouter(): Router {
  const router = Router();
  const controller = new PayrollController(new PayrollService(getDatabase(), new TransfersService(getDatabase())));
  const base = "/api/businesses/:businessId/payroll";

  router.use(base, requireAuth);
  router.get(`${base}/runs`, controller.listRuns);
  router.post(`${base}/runs`, controller.createRun);
  router.get(`${base}/runs/:runId`, controller.getRun);
  router.post(`${base}/runs/:runId/approve`, controller.approveRun);
  router.post(`${base}/runs/:runId/pay`, controller.payRun);
  router.post(`${base}/runs/:runId/cancel`, controller.cancelRun);

  return router;
}
