import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ComplianceController } from "./compliance.controller.js";
import { ComplianceService } from "./compliance.service.js";

export function createComplianceRouter(): Router {
  const router = Router();
  const controller = new ComplianceController(new ComplianceService(getDatabase()));
  const base = "/api/businesses/:businessId/compliance";

  router.use(base, requireAuth);
  router.get(`${base}/legal-profile`, controller.getLegalProfile);
  router.put(`${base}/legal-profile`, controller.upsertLegalProfile);

  router.get(`${base}/beneficial-owners`, controller.listBeneficialOwners);
  router.post(`${base}/beneficial-owners`, controller.createBeneficialOwner);
  router.patch(`${base}/beneficial-owners/:ownerId`, controller.updateBeneficialOwner);
  router.delete(`${base}/beneficial-owners/:ownerId`, controller.archiveBeneficialOwner);

  router.get(`${base}/cases`, controller.listCases);
  router.post(`${base}/cases`, controller.openCase);
  router.get(`${base}/cases/:caseId`, controller.getCase);
  router.patch(`${base}/cases/:caseId`, controller.updateCase);

  router.get(`${base}/cases/:caseId/documents`, controller.listDocuments);
  router.post(`${base}/cases/:caseId/documents`, controller.addDocument);

  router.get(`${base}/cases/:caseId/submissions`, controller.listSubmissions);
  router.post(`${base}/cases/:caseId/submissions`, controller.recordSubmission);

  const consentsBase = "/api/me/consents";
  router.use(consentsBase, requireAuth);
  router.get(consentsBase, controller.listConsents);
  router.post(consentsBase, controller.grantConsent);
  router.delete(`${consentsBase}/:consentId`, controller.revokeConsent);

  const privacyBase = "/api/me/data-privacy-requests";
  router.use(privacyBase, requireAuth);
  router.get(privacyBase, controller.listPrivacyRequests);
  router.post(privacyBase, controller.createPrivacyRequest);

  return router;
}
