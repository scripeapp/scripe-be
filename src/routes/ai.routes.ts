/**
 * AI Routes
 * Endpoints for AI-powered text enhancement
 */

import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requireFeature } from "../middleware/feature-access.middleware";
import { withSupabase } from "../types/http";
import { aiController } from "../controllers/ai.controller";
import { z } from "zod";
import { validateRequest } from "../middleware/validation.middleware";
import { createAiRateLimit } from "../middleware/ai-rate-limit.middleware";

const router = Router();

const aiRateLimit = createAiRateLimit("ai", 10);

// Validation Schemas
const enhanceSchema = z.object({
  text: z.string().min(1, "Text is required").max(10000, "Text too long (max 10000 characters)"),
  action: z.enum(["improve", "expand", "shorten", "professional"]),
  context: z.enum([
    "product_description",
    "post_content",
    "campaign_email",
    "event_description",
    "business_bio",
    "session_description",
    "general",
  ]).optional().default("general"),
  additionalInstructions: z.string().max(500).optional(),
});

const generateSchema = z.object({
  prompt: z.string().min(1, "Prompt is required").max(2000, "Prompt too long (max 2000 characters)"),
  context: z.enum([
    "product_description",
    "post_content",
    "campaign_email",
    "event_description",
    "business_bio",
    "session_description",
    "general",
  ]).optional().default("general"),
  maxLength: z.number().int().min(50).max(5000).optional(),
});

// Routes

/**
 * POST /api/ai/enhance
 * Enhance existing text with AI
 * Requires: authenticated user, paid plan (plus or pro)
 */
router.post(
  "/enhance",
  authenticateUser,
  requireFeature("ai_assistant"),
  aiRateLimit,
  validateRequest(enhanceSchema, "body"),
  withSupabase(aiController.enhanceText.bind(aiController))
);

/**
 * POST /api/ai/generate
 * Generate new text from a prompt
 * Requires: authenticated user, paid plan (plus or pro)
 */
router.post(
  "/generate",
  authenticateUser,
  requireFeature("ai_assistant"),
  aiRateLimit,
  validateRequest(generateSchema, "body"),
  withSupabase(aiController.generateText.bind(aiController))
);

/**
 * GET /api/ai/status
 * Check AI service availability (public, for feature detection)
 */
router.get(
  "/status",
  authenticateUser,
  withSupabase(aiController.getStatus.bind(aiController))
);

export default router;
