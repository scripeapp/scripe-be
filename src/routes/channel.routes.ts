import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import { channelController as cc } from "../controllers/channel.controller";
import { validateRequest } from "../middleware/validation.middleware";
import { channelSchemas } from "../types/channel.schemas";

const router = Router({ mergeParams: true });

// All routes receive :channel param from parent router (whatsapp | sms)

// ── Messages ──────────────────────────────────────────────────────────────────
router.get("/messages", authenticateUser, withSupabase(cc.getMessages));
router.get(
  "/messages/aggregate",
  authenticateUser,
  withSupabase(cc.getMessageStats),
);
router.get("/messages/:id", authenticateUser, withSupabase(cc.getMessage));
router.get(
  "/messages/:id/stats",
  authenticateUser,
  withSupabase(cc.getMessageStat),
);
router.post(
  "/messages/estimate",
  authenticateUser,
  validateRequest(channelSchemas.estimateMessage, "body"),
  withSupabase(cc.estimateMessage),
);
router.post(
  "/messages",
  authenticateUser,
  validateRequest(channelSchemas.createMessage, "body"),
  withSupabase(cc.createMessage),
);
router.patch(
  "/messages/:id",
  authenticateUser,
  validateRequest(channelSchemas.updateMessage, "body"),
  withSupabase(cc.updateMessage),
);
router.delete(
  "/messages/:id",
  authenticateUser,
  withSupabase(cc.deleteMessage),
);
router.post(
  "/messages/:id/send",
  authenticateUser,
  validateRequest(channelSchemas.sendMessage, "body"),
  withSupabase(cc.sendMessage),
);

// ── Templates ─────────────────────────────────────────────────────────────────
router.get("/templates", authenticateUser, withSupabase(cc.getTemplates));
router.get("/templates/:id", authenticateUser, withSupabase(cc.getTemplate));
router.post("/templates", authenticateUser, withSupabase(cc.createTemplate));
router.patch(
  "/templates/:id",
  authenticateUser,
  withSupabase(cc.updateTemplate),
);
router.delete(
  "/templates/:id",
  authenticateUser,
  withSupabase(cc.deleteTemplate),
);
router.post(
  "/templates/:id/submit",
  authenticateUser,
  withSupabase(cc.submitTemplate),
);

export default router;
