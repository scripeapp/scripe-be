import { Router } from "express";
import { z } from "zod";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { withSupabase } from "../types/http";
import { uploadController } from "../controllers/upload.controller";

const router = Router();

const presignSchema = z.object({
  fileName: z.string().min(1, "fileName is required"),
  mimeType: z.string().min(1, "mimeType is required"),
  sizeBytes: z.number().positive("sizeBytes must be positive"),
  context: z.string().min(1, "context is required"),
  entityId: z.string().optional(),
  businessId: z.string().uuid("businessId must be a valid UUID"),
});

const confirmSchema = z.object({
  uploadId: z.string().uuid("uploadId must be a valid UUID"),
});

/**
 * POST /api/upload/presign
 * Request a presigned R2 PUT URL for direct browser-to-R2 video upload
 */
router.post(
  "/presign",
  authenticateUser,
  validateRequest(presignSchema),
  withSupabase(uploadController.presignUpload.bind(uploadController)),
);

/**
 * POST /api/upload/confirm
 * Confirm a completed upload and trigger QStash video-processing job
 */
router.post(
  "/confirm",
  authenticateUser,
  validateRequest(confirmSchema),
  withSupabase(uploadController.confirmUpload.bind(uploadController)),
);

/**
 * POST /api/upload/process-video
 * QStash callback — signature verified inline; no user auth
 */
router.post(
  "/process-video",
  uploadController.processVideo.bind(uploadController),
);

export default router;
