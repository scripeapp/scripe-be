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

  router.get("/api/banks", controller.listBanks);

  router.use(base, requireAuth);
  router.get("/api/businesses/:businessId/subaccount", requireAuth, controller.getSubaccount);
  router.put("/api/businesses/:businessId/subaccount", requireAuth, controller.getSubaccount);
  router.get(`${base}/banks`, controller.listBanks);
  router.get(`${base}/status`, controller.getStatus);
  router.get(`${base}/resolve-account`, controller.resolveBankAccount);
  router.post(`${base}/kyc`, controller.submitKyc);
  router.post(`${base}/kyb`, controller.submitKyb);
  router.post(`${base}/virtual-account`, controller.requestVirtualAccount);
  router.post(`${base}/virtual-account/requery`, controller.requeryVirtualAccount);
  router.get(`${base}/transactions`, controller.listWalletTransactions);
  router.post(`${base}/withdrawals`, controller.requestWithdrawal);
  router.post(`${base}/withdrawals/finalize`, controller.finalizeWithdrawal);

  // Platform administrators review corporate KYB that the provider doesn't
  // verify itself (Brails). Role checks live in the service.
  const reviewsBase = "/api/platform/banking/kyb-reviews";
  router.use(reviewsBase, requireAuth);
  router.get(reviewsBase, controller.listKybReviews);
  router.get(`${reviewsBase}/:businessId`, controller.getKybReview);
  router.post(`${reviewsBase}/:businessId/decision`, controller.reviewKyb);

  return router;
}
