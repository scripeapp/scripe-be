import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { RiskController } from "./risk.controller.js";
import { RiskService } from "./risk.service.js";

export function createRiskRouter(): Router {
  const router = Router();
  const controller = new RiskController(new RiskService(getDatabase()));
  const base = "/api/risk";
  router.use(base, requireAuth);

  router.get(`${base}/signals`, controller.listSignals);
  router.get(`${base}/stats`, controller.getStats);
  router.patch(`${base}/signals/:signalId/review`, controller.reviewSignal);

  router.get(`${base}/cases`, controller.listCases);
  router.post(`${base}/cases`, controller.createCase);
  router.get(`${base}/cases/:caseId`, controller.getCase);
  router.patch(`${base}/cases/:caseId`, controller.updateCase);

  router.get(`${base}/holds`, controller.listHolds);
  router.post(`${base}/holds`, controller.createHold);
  router.post(`${base}/holds/:holdId/release`, controller.releaseHold);

  const fraudBase = "/api/platform/fraud";
  router.use(fraudBase, requireAuth);
  router.get(`${fraudBase}/signals`, controller.listSignals);
  router.get(`${fraudBase}/stats`, controller.getStats);
  router.patch(`${fraudBase}/signals/:signalId/review`, controller.reviewSignal);

  const riskPlatformBase = "/api/platform/risk";
  router.use(riskPlatformBase, requireAuth);
  router.get(`${riskPlatformBase}/signals`, controller.listSignals);
  router.get(`${riskPlatformBase}/stats`, controller.getStats);
  router.patch(`${riskPlatformBase}/signals/:signalId/review`, controller.reviewSignal);

  return router;
}
