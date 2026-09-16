/**
 * Dashboard AI agent routes (Command Center panel).
 * All routes 404 when the AI_AGENT_ENABLED kill-switch is off, so
 * disabling the feature fully restores the pre-agent surface area.
 */
import { Router, Request, Response, NextFunction } from "express";
import { SupabaseClient } from "@supabase/supabase-js";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requireFeature } from "../middleware/feature-access.middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { createAiRateLimit } from "../middleware/ai-rate-limit.middleware";
import { PermissionService } from "../services/permission.service";
import { getAction } from "../services/ai/pending-action.store";
import { actionPermission } from "../services/ai/action-executor.service";
import multer from "multer";
import {
  upload,
  MAX_UPLOAD_FILE_SIZE_MB,
} from "../middleware/upload.middleware";
import { withSupabase } from "../types/http";
import {
  aiAgentController,
  isAgentEnabled,
} from "../controllers/ai-agent.controller";
import {
  agentChatSchema,
  submitAnswersSchema,
} from "../types/ai-agent.types";

const router = Router();

const agentRateLimit = createAiRateLimit("ai-agent", 20);

// Same multer-error-to-400 wrapper pattern as store.routes.ts.
const uploadDocumentFile = upload.single("file");
function handleDocumentUpload(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  uploadDocumentFile(req, res, (error) => {
    if (!error) {
      return next();
    }
    if (
      error instanceof multer.MulterError &&
      error.code === "LIMIT_FILE_SIZE"
    ) {
      return res.status(400).json({
        success: false,
        error: `File size exceeds maximum of ${MAX_UPLOAD_FILE_SIZE_MB}MB`,
      });
    }
    return next(error);
  });
}

/** Kill-switch (AI_AGENT_ENABLED env + admin DB toggle) — checked before
 *  anything else. */
function requireAgentEnabled(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  isAgentEnabled()
    .then((enabled) => {
      if (!enabled) {
        return res.status(404).json({
          success: false,
          error: "not_found",
          message: "Not found",
        });
      }
      return next();
    })
    .catch(next);
}

/**
 * Action-approval gate: resolves the business from the pending action
 * itself (never from client input) and checks the permission mapped to
 * that action type, so event actions require event.create, product
 * actions their own permission, etc.
 */
interface ActionPermissionRequest extends Request {
  user_id?: string;
  supabase?: SupabaseClient;
  businessId?: string;
}

async function requireActionPermission(
  req: ActionPermissionRequest,
  res: Response,
  next: NextFunction,
) {
  try {
    const action = await getAction(req.params.actionId as string);
    if (!action) {
      return res.status(404).json({
        success: false,
        error: "action_not_found",
        message: "This action no longer exists.",
      });
    }
    const permission = actionPermission(action.type);
    if (!permission) {
      return res.status(500).json({
        success: false,
        error: "unsupported_action",
        message: "This action type has no execution path.",
      });
    }

    const userId = req.user_id;
    const db = req.supabase;
    if (!userId || !db) {
      return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    req.businessId = action.businessId;
    const permissionService = new PermissionService(db);
    const hasPermission = await permissionService.hasPermission(
      userId,
      action.businessId,
      permission,
    );
    if (!hasPermission) {
      return res.status(403).json({
        success: false,
        error: `Access denied: Missing permission '${permission}'`,
      });
    }
    return next();
  } catch (error: any) {
    console.error("[AIAgent] action permission check failed:", error);
    return res
      .status(500)
      .json({ success: false, error: "Authorization error" });
  }
}

router.get(
  "/capabilities",
  requireAgentEnabled,
  authenticateUser,
  requirePermission("analytics.read"),
  requireFeature("ai_assistant"),
  withSupabase(aiAgentController.getCapabilities.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/chat
 * One agent turn, streamed as SSE.
 * requirePermission("analytics.read") both verifies the caller belongs to
 * the business (requireFeature alone only checks the business's plan) and
 * sets req.businessId for the rate limiter + controller.
 */
router.post(
  "/chat",
  requireAgentEnabled,
  authenticateUser,
  requirePermission("analytics.read"),
  requireFeature("ai_assistant"),
  agentRateLimit,
  validateRequest(agentChatSchema, "body"),
  withSupabase(aiAgentController.chat.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/documents
 * Attach a document (PDF/docx/txt/md/json/csv) to the caller's session.
 * Multer runs BEFORE requireFeature/rate-limit — multipart bodies aren't
 * parsed until it does, and both read req.body.business_id.
 */
router.post(
  "/documents",
  requireAgentEnabled,
  authenticateUser,
  handleDocumentUpload,
  requirePermission("analytics.read"),
  requireFeature("ai_assistant"),
  agentRateLimit,
  withSupabase(aiAgentController.uploadDocument.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/drafts/:draftId/approve
 * Provision a store from an extraction draft — the merchant's explicit
 * approval step. Store-creation permission enforced server-side.
 */
router.post(
  "/drafts/:draftId/approve",
  requireAgentEnabled,
  authenticateUser,
  requirePermission("store.settings.create"),
  requireFeature("ai_assistant"),
  withSupabase(aiAgentController.approveDraft.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/drafts/:draftId/reject
 * Discard an extraction draft.
 */
router.post(
  "/drafts/:draftId/reject",
  requireAgentEnabled,
  authenticateUser,
  withSupabase(aiAgentController.rejectDraft.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/answers
 * One SSE agent turn continuing after the merchant answered a detail
 * card. Same auth shape as /chat.
 */
router.post(
  "/answers",
  requireAgentEnabled,
  authenticateUser,
  requirePermission("analytics.read"),
  requireFeature("ai_assistant"),
  agentRateLimit,
  validateRequest(submitAnswersSchema, "body"),
  withSupabase(aiAgentController.submitAnswers.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/actions/:actionId/approve
 * Execute a pending action — the merchant's explicit approval step. The
 * required permission depends on the action type (e.g. event.create for
 * event actions), enforced server-side before the controller runs.
 */
router.post(
  "/actions/:actionId/approve",
  requireAgentEnabled,
  authenticateUser,
  requireActionPermission,
  requireFeature("ai_assistant"),
  withSupabase(aiAgentController.approveAction.bind(aiAgentController)),
);

/**
 * POST /api/ai/agent/actions/:actionId/reject
 * Discard a pending action.
 */
router.post(
  "/actions/:actionId/reject",
  requireAgentEnabled,
  authenticateUser,
  withSupabase(aiAgentController.rejectAction.bind(aiAgentController)),
);

/**
 * DELETE /api/ai/agent/session
 * Clear the caller's conversation, attached document, and draft pointer.
 */
router.delete(
  "/session",
  requireAgentEnabled,
  authenticateUser,
  withSupabase(aiAgentController.resetSession.bind(aiAgentController)),
);

export default router;
