import { Router } from "express";
import { FinancialsController } from "../controllers/financials.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";

const router = Router();
const controller = new FinancialsController();

/**
 * @route GET /api/financials/summary
 */
router.get(
  "/summary",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  withSupabase(controller.getSummary.bind(controller)),
);

/**
 * @route GET /api/financials/ledger
 */
router.get(
  "/ledger",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  withSupabase(controller.getLedger.bind(controller)),
);

/**
 * @route GET /api/financials/expenses
 */
router.get(
  "/expenses",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  withSupabase(controller.getExpenses.bind(controller)),
);

/**
 * @route POST /api/financials/expenses
 */
router.post(
  "/expenses",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  withSupabase(controller.createExpense.bind(controller)),
);

/**
 * @route PUT /api/financials/expenses/:id
 */
router.put(
  "/expenses/:id",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  withSupabase(controller.updateExpense.bind(controller)),
);

/**
 * @route DELETE /api/financials/expenses/:id
 */
router.delete(
  "/expenses/:id",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  withSupabase(controller.deleteExpense.bind(controller)),
);

/**
 * @route GET /api/financials/settlements
 */
router.get(
  "/settlements",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  withSupabase(controller.getSettlements.bind(controller)),
);

/**
 * @route GET /api/financials/payouts
 */
router.get(
  "/payouts",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  withSupabase(controller.getPayoutRequests.bind(controller)),
);

/**
 * @route POST /api/financials/payouts/request
 */
router.post(
  "/payouts/request",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  withSupabase(controller.requestPayout.bind(controller)),
);

export default router;
