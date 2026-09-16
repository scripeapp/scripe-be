import express from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { SocialController } from "../controllers/social.controller";
import { withSupabase } from "../types/http";

const router = express.Router();

// Follow/Unfollow User
router.post(
  "/follow/:userId",
  authenticateUser,
  withSupabase(SocialController.followUser),
);
router.delete(
  "/follow/:userId",
  authenticateUser,
  withSupabase(SocialController.unfollowUser),
);

// Likes Toggle
router.post(
  "/likes",
  authenticateUser,
  withSupabase(SocialController.toggleLike),
);

export default router;
