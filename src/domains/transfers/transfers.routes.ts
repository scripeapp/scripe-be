import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { TransfersController } from "./transfers.controller.js";
import { TransfersService } from "./transfers.service.js";

export function createTransfersRouter(): Router {
  const router = Router();
  const controller = new TransfersController(new TransfersService(getDatabase()));
  const base = "/api/businesses/:businessId/transfers";

  router.use(base, requireAuth);
  router.get(`${base}/beneficiaries`, controller.listBeneficiaries);
  router.post(`${base}/beneficiaries`, controller.createBeneficiary);
  router.get(`${base}/beneficiaries/:beneficiaryId`, controller.getBeneficiary);
  router.delete(`${base}/beneficiaries/:beneficiaryId`, controller.archiveBeneficiary);
  router.get(base, controller.listTransfers);
  router.post(base, controller.requestTransfer);
  router.get(`${base}/:transferId`, controller.getTransfer);

  return router;
}
