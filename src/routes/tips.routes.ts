import express from "express";
import { withSupabase } from "../types/http";
import { initiateTipPayment } from "../controllers/tips.controller";

const router = express.Router();

// POST /api/tips/initiate — server-side Paystack payment init for tipping
router.post("/initiate", withSupabase(initiateTipPayment));

export default router;
