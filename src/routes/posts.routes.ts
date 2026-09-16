import { Router } from "express";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import { PostsController } from "../controllers/posts.controller";
import upload from "../middleware/upload.middleware";

const router = Router();

// ============================================================================
// Posts
// ============================================================================

// Get all posts (with optional publication filter)
router.get("/", authenticateUser, withSupabase(PostsController.getPosts));

// Create a new post
router.post("/", authenticateUser, withSupabase(PostsController.createPost));

// Get post details
router.get(
  "/:id",
  authenticateOptional,
  withSupabase(PostsController.getPostDetails),
);

// Update post
router.patch(
  "/:id",
  authenticateUser,
  withSupabase(PostsController.updatePost),
);

// Delete post
router.delete(
  "/:id",
  authenticateUser,
  withSupabase(PostsController.deletePost),
);

// Publish post
router.post(
  "/:id/publish",
  authenticateUser,
  withSupabase(PostsController.publishPost),
);

// Unpublish post (revert to draft)
router.post(
  "/:id/unpublish",
  authenticateUser,
  withSupabase(PostsController.unpublishPost),
);

router.post(
  "/:id/archive",
  authenticateUser,
  withSupabase(PostsController.archivePost),
);

router.post(
  "/:id/restore",
  authenticateUser,
  withSupabase(PostsController.restorePost),
);

// Schedule post
router.post(
  "/:id/schedule",
  authenticateUser,
  withSupabase(PostsController.schedulePost),
);

// Unschedule post (revert to draft)
router.post(
  "/:id/unschedule",
  authenticateUser,
  withSupabase(PostsController.unschedulePost),
);

// ============================================================================
// Comments
// ============================================================================

router.get(
  "/comments/all/:post_id",
  authenticateOptional,
  withSupabase(PostsController.getComments),
);
router.get(
  "/comments/:comment_id/replies",
  authenticateOptional,
  withSupabase(PostsController.getReplies),
);
router.post(
  "/comments/create",
  authenticateUser,
  withSupabase(PostsController.createComment),
);
router.patch(
  "/comments/:id",
  authenticateUser,
  withSupabase(PostsController.updateComment),
);
router.delete(
  "/comments/:id",
  authenticateUser,
  withSupabase(PostsController.deleteComment),
);

// ============================================================================
// STORAGE ROUTES
// ============================================================================
router.post(
  "/upload/image",
  authenticateUser,
  upload.single("file"),
  withSupabase(PostsController.uploadPostImage),
);

export default router;
