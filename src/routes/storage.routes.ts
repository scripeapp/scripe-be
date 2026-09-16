import { Router } from "express";
import { StorageController } from "../controllers/storage.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import upload from "../middleware/upload.middleware";

const router = Router();

/**
 * Handle file uploads
 * POST /api/storage/upload?bucket=[bucket]&path=[path]
 */
router.post(
  "/upload",
  authenticateUser,
  upload.single("file"),
  withSupabase(StorageController.uploadFile),
);

export default router;
