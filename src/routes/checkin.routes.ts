import express from "express";
import { validateRequest } from "../middleware/validation.middleware";
import { checkinSchemas } from "../types/checkin.schemas";
import { checkinController } from "../controllers/checkin.controller";
import { withSupabase } from "../types/http";

const router = express.Router();

/**
 * POST /api/checkin/auth
 * Public endpoint. Validates an event access code and returns a signed
 * check-in token valid for 8 hours. No user credentials required.
 */
router.post(
  "/auth",
  validateRequest(checkinSchemas.authenticateWithCode, "body"),
  withSupabase(checkinController.authenticateWithCode.bind(checkinController)),
);

export default router;
