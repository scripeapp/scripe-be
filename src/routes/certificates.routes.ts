import express from "express";
import { authenticateOptional } from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import { getPublicCertificate } from "../controllers/courses.controller";

const router = express.Router();

// GET /api/certificates/:certificateId — public verification
router.get("/:certificateId", authenticateOptional, withSupabase(getPublicCertificate));

export default router;
