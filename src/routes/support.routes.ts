import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { FeatureRequestSchema } from "../types/support.schemas";
import { submitFeatureRequest } from "../controllers/support.controller";
import { withSupabase } from "../types/http";

const router = Router();

router.post(
  "/feature-request",
  authenticateUser,
  validateRequest(FeatureRequestSchema),
  withSupabase(submitFeatureRequest)
);

export default router;
