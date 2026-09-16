import { Router } from "express";
import { BookkeepingController } from "../controllers/bookkeeping.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";

const router = Router();
const controller = new BookkeepingController();

// Use businessAwareRequest for all routes to ensure user has access to the business
// Bookkeeping is a dashboard feature, so it should be protected by auth and business permissions
router.get(
  "/ledger",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  (req, res) => controller.getLedger(req as any, res),
);
router.get(
  "/summary",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  (req, res) => controller.getSummary(req as any, res),
);

router.post(
  "/transactions",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  (req, res) => controller.createTransaction(req as any, res),
);
router.patch(
  "/transactions/:id",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  (req, res) => controller.updateTransaction(req as any, res),
);
router.delete(
  "/transactions/:id",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  (req, res) => controller.deleteTransaction(req as any, res),
);

export default router;
