import { Router } from "express";
import PaymentController from "../controllers/payment.controller";
import { authenticateUser, authenticateOptional } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { withSupabase } from "../types/http";
import { paymentSchemas } from "../types/payment.schemas";

const router = Router();

/**
 * @route GET /api/payments/verify/:reference
 * Public (optional auth) — verifies a transaction for order-success pages.
 * Returns the full Paystack record including failed/abandoned statuses.
 */
router.get(
  "/verify/:reference",
  authenticateOptional,
  validateRequest(paymentSchemas.verifyParams, "params"),
  withSupabase(PaymentController.verify.bind(PaymentController)),
);

/**
 * @route GET /api/payments/billing-history
 * Authenticated — returns the caller's own Paystack billing history.
 */
router.get(
  "/billing-history",
  authenticateUser,
  withSupabase(PaymentController.billingHistory.bind(PaymentController)),
);

/**
 * @route GET /api/payments/transactions
 * Authenticated — a business's store checkout payment records.
 */
router.get(
  "/transactions",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  validateRequest(paymentSchemas.listTransactions, "query"),
  withSupabase(PaymentController.listTransactions.bind(PaymentController)),
);

export default router;
