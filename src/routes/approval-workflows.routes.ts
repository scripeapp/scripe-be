import { Router } from "express";
import { ApprovalWorkflowController } from "../controllers/approval-workflow.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { approvalSchemas } from "../types/approvals.schemas";
import { withSupabase } from "../types/http";

const router = Router();
const controller = new ApprovalWorkflowController();

router.get(
  "/",
  authenticateUser,
  requirePermission("approvals.workflow.read"),
  validateRequest(approvalSchemas.listWorkflows, "query"),
  withSupabase(controller.listWorkflows),
);

router.get(
  "/:id",
  authenticateUser,
  requirePermission("approvals.workflow.read"),
  validateRequest(approvalSchemas.workflowIdParam, "params"),
  validateRequest(approvalSchemas.businessIdQuery, "query"),
  withSupabase(controller.getWorkflow),
);

router.post(
  "/",
  authenticateUser,
  requirePermission("approvals.workflow.manage"),
  validateRequest(approvalSchemas.createWorkflow, "body"),
  withSupabase(controller.createWorkflow),
);

router.patch(
  "/:id",
  authenticateUser,
  requirePermission("approvals.workflow.manage"),
  validateRequest(approvalSchemas.workflowIdParam, "params"),
  validateRequest(approvalSchemas.updateWorkflow, "body"),
  withSupabase(controller.updateWorkflow),
);

router.post(
  "/:id/toggle-status",
  authenticateUser,
  requirePermission("approvals.workflow.manage"),
  validateRequest(approvalSchemas.workflowIdParam, "params"),
  validateRequest(approvalSchemas.businessIdBody, "body"),
  withSupabase(controller.toggleWorkflowStatus),
);

router.post(
  "/:id/duplicate",
  authenticateUser,
  requirePermission("approvals.workflow.manage"),
  validateRequest(approvalSchemas.workflowIdParam, "params"),
  validateRequest(approvalSchemas.businessIdBody, "body"),
  withSupabase(controller.duplicateWorkflow),
);

router.delete(
  "/:id",
  authenticateUser,
  requirePermission("approvals.workflow.manage"),
  validateRequest(approvalSchemas.workflowIdParam, "params"),
  validateRequest(approvalSchemas.businessIdQuery, "query"),
  withSupabase(controller.deleteWorkflow),
);

// ============================================================================
// Approval requests (runtime decisions) — deliberately NOT gated by
// requirePermission. Per docs/transfers-approvals-backend-plan.md,
// eligibility to decide a specific request is a per-row, per-step check
// done in the service layer (is this user actually listed as an approver
// on the current step) — authenticateUser + RLS already keep non-members
// out entirely.
// ============================================================================

router.get(
  "/requests/pending",
  authenticateUser,
  validateRequest(approvalSchemas.businessIdQuery, "query"),
  withSupabase(controller.listPendingApprovals),
);

router.post(
  "/requests/:requestId/approve",
  authenticateUser,
  validateRequest(approvalSchemas.requestIdParam, "params"),
  validateRequest(approvalSchemas.decideApprovalRequest, "body"),
  withSupabase(controller.approveRequest),
);

router.post(
  "/requests/:requestId/reject",
  authenticateUser,
  validateRequest(approvalSchemas.requestIdParam, "params"),
  validateRequest(approvalSchemas.decideApprovalRequest, "body"),
  withSupabase(controller.rejectRequest),
);

export default router;
