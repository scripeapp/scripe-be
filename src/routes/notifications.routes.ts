import express from "express";
import {
  handleNewComment,
  handleNewLike,
  handleNewPost,
  handleNewPublication,
  handleNewSubscriber,
  handleNewPostToSubscribers,
  handleNewTip,
} from "../controllers/notifications.controller";
import { withSupabase } from "../types/http";
import { authenticateOptional } from "../middleware/supabase-auth-middleware";

const router = express.Router();

router.post(
  "/new-comment",
  authenticateOptional,
  withSupabase(handleNewComment),
);
router.post("/new-like", authenticateOptional, withSupabase(handleNewLike));
router.post("/new-post", authenticateOptional, withSupabase(handleNewPost));
router.post(
  "/new-publication",
  authenticateOptional,
  withSupabase(handleNewPublication),
);
router.post(
  "/new-subscriber",
  authenticateOptional,
  withSupabase(handleNewSubscriber),
);
router.post(
  "/new-post-to-subscribers",
  authenticateOptional,
  withSupabase(handleNewPostToSubscribers),
);
router.post("/new-tip", authenticateOptional, withSupabase(handleNewTip));

export default router;
