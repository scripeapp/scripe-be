import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { BankingService } from "../banking/banking.service.js";
import { PayablesService } from "../payables/payables.service.js";
import { ApprovalsController } from "./approvals.controller.js";
import { ApprovalsService } from "./approvals.service.js";

export function createApprovalsRouter(): Router {
  const router = Router();
  const approvals = new ApprovalsService(getDatabase());
  const controller = new ApprovalsController(approvals, new BankingService(getDatabase(), approvals), new PayablesService(getDatabase(), approvals));
  const workflowsBase = "/api/businesses/:businessId/approval-workflows";
  const requestsBase = "/api/businesses/:businessId/approvals";

  router.use(workflowsBase, requireAuth);
  router.get(workflowsBase, controller.listWorkflows);
  router.get(`${workflowsBase}/:workflowId`, controller.getWorkflow);
  router.post(workflowsBase, controller.createWorkflow);
  router.patch(`${workflowsBase}/:workflowId`, controller.updateWorkflow);
  router.post(`${workflowsBase}/:workflowId/status`, controller.setWorkflowStatus);
  router.post(`${workflowsBase}/:workflowId/duplicate`, controller.duplicateWorkflow);
  router.delete(`${workflowsBase}/:workflowId`, controller.deleteWorkflow);

  // No requirePermission on these three — eligibility to see/decide a
  // specific pending request is a per-row, per-step check done in the
  // service layer (who's actually listed as an approver on the current
  // step), not a blanket role permission. Matches legacy's explicit design
  // choice (see docs/transfers-approvals-backend-plan.md).
  router.use(requestsBase, requireAuth);
  router.get(requestsBase, controller.listPending);
  router.post(`${requestsBase}/:requestId/approve`, controller.approve);
  router.post(`${requestsBase}/:requestId/reject`, controller.reject);

  return router;
}
