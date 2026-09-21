import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ApprovalsService } from "../approvals/approvals.service.js";
import { BankingController } from "./banking.controller.js";
import { BankingService } from "./banking.service.js";

export function createBankingRouter(): Router {
  const router = Router();
  const controller = new BankingController(new BankingService(getDatabase(), new ApprovalsService(getDatabase())));
  const base = "/api/businesses/:businessId/banking";

  router.use(base, requireAuth);
  router.get(`${base}/status`, controller.getStatus);
  router.get(`${base}/resolve-account`, controller.resolveBankAccount);
  router.post(`${base}/kyc`, controller.submitKyc);
  router.post(`${base}/virtual-account`, controller.requestVirtualAccount);
  router.post(`${base}/virtual-account/requery`, controller.requeryVirtualAccount);
  router.get(`${base}/transactions`, controller.listWalletTransactions);
  router.post(`${base}/withdrawals`, controller.requestWithdrawal);
  router.post(`${base}/withdrawals/finalize`, controller.finalizeWithdrawal);

  return router;
}
