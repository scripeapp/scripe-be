/**
 * Express route composition for the bill, bill line, and bill payment allocation domain
 * belongs here. Routes are registered only after the capability and contract are
 * approved.
 */
import { Router } from "express"; import { getDatabase } from "../../db/database.js"; import { requireAuth } from "../../middleware/auth.js"; import { ApprovalsService } from "../approvals/approvals.service.js"; import { PayablesController } from "./payables.controller.js"; import { PayablesService } from "./payables.service.js";
export function createPayablesRouter(): Router {
  const router = Router();
  const controller = new PayablesController(new PayablesService(getDatabase(), new ApprovalsService(getDatabase())));
  const base = "/api/businesses/:businessId/payables";
  router.use(base, requireAuth);

  router.get(`${base}/bills`, controller.listBills);
  router.get(`${base}/bills/metrics`, controller.getMetrics);
  router.get(`${base}/bills/:billId`, controller.getBill);
  router.get(`${base}/bills/:billId/items`, controller.getBillLines);
  router.get(`${base}/bills/:billId/lines`, controller.getBillLines);
  router.post(`${base}/bills`, controller.createBill);
  router.patch(`${base}/bills/:billId`, controller.updateBill);
  router.post(`${base}/bills/:billId/approve`, controller.approveBill);
  router.post(`${base}/bills/:billId/reject`, controller.rejectBill);
  router.delete(`${base}/bills/:billId`, controller.deleteBill);
  router.post(`${base}/bills/:billId/payments`, controller.allocatePayment);

  return router;
}
