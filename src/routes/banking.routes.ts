import { Router } from "express";
import { BankingController } from "../controllers/banking.controller";
import { PinController } from "../controllers/pin.controller";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { bankingSchemas } from "../types/banking.schemas";
import { pinSchemas } from "../types/pin.schemas";
import { withSupabase } from "../types/http";

const router = Router();
const controller = new BankingController();
const pinController = new PinController();

router.get(
  "/status",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  validateRequest(bankingSchemas.businessIdQuery, "query"),
  withSupabase(controller.getStatus),
);

router.post(
  "/kyc",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.submitKyc, "body"),
  withSupabase(controller.submitKyc),
);

router.post(
  "/virtual-account",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.requestVirtualAccount, "body"),
  withSupabase(controller.requestVirtualAccount),
);

router.post(
  "/virtual-account/requery",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.businessIdBody, "body"),
  withSupabase(controller.requeryVirtualAccount),
);

router.get(
  "/transactions",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  validateRequest(bankingSchemas.listTransactions, "query"),
  withSupabase(controller.listTransactions),
);

router.get(
  "/resolve-account",
  authenticateUser,
  requirePermission("rm.analytics.view"),
  validateRequest(bankingSchemas.resolveBankAccount, "query"),
  withSupabase(controller.resolveBankAccount),
);

router.post(
  "/withdrawals",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.requestWithdrawal, "body"),
  withSupabase(controller.requestWithdrawal),
);

router.post(
  "/withdrawals/finalize",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.finalizeWithdrawal, "body"),
  withSupabase(controller.finalizeWithdrawal),
);

router.post(
  "/pin",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(pinSchemas.setPin, "body"),
  withSupabase(pinController.setPin),
);

router.post(
  "/pin/reset-bvn",
  authenticateUser,
  requirePermission("rm.analytics.manage"),
  validateRequest(bankingSchemas.resetBvnPin, "body"),
  withSupabase(controller.resetBvnPin),
);

export default router;
