import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { CommunicationsController } from "./communications.controller.js";
import { CommunicationsService } from "./communications.service.js";

export function createCommunicationsRouter(): Router {
  const router = Router();
  const controller = new CommunicationsController(new CommunicationsService(getDatabase()));
  const base = "/api/businesses/:businessId";
  router.use(base, requireAuth);

  router.get(`${base}/communications/domains`, controller.listDomains);
  router.post(`${base}/communications/domains`, controller.addDomain);
  router.post(`${base}/communications/domains/:domainId/verify`, controller.verifyDomain);
  router.delete(`${base}/communications/domains/:domainId`, controller.deleteDomain);

  router.get(`${base}/communications/senders`, controller.listSenders);
  router.post(`${base}/communications/senders`, controller.createSender);
  router.patch(`${base}/communications/senders/:senderId`, controller.updateSender);
  router.post(`${base}/communications/senders/:senderId/default`, controller.setDefaultSender);
  router.delete(`${base}/communications/senders/:senderId`, controller.deleteSender);

  router.get(`${base}/communications/templates`, controller.listTemplates);
  router.post(`${base}/communications/templates`, controller.createTemplate);
  router.patch(`${base}/communications/templates/:templateId`, controller.updateTemplate);
  router.delete(`${base}/communications/templates/:templateId`, controller.deleteTemplate);

  router.get(`${base}/communications/segments`, controller.listSegments);
  router.post(`${base}/communications/segments`, controller.createSegment);
  router.patch(`${base}/communications/segments/:segmentId`, controller.updateSegment);
  router.delete(`${base}/communications/segments/:segmentId`, controller.deleteSegment);
  router.get(`${base}/communications/segments/:segmentId/members`, controller.listSegmentMembers);
  router.post(`${base}/communications/segments/:segmentId/members`, controller.addSegmentMembers);
  router.delete(`${base}/communications/segments/:segmentId/members/:partyId`, controller.removeSegmentMember);

  router.get(`${base}/communications/opt-outs`, controller.listOptOuts);
  router.post(`${base}/communications/opt-outs`, controller.optOut);
  router.post(`${base}/communications/opt-ins`, controller.optIn);

  router.get(`${base}/communications/credits/packages`, controller.listPackages);
  router.get(`${base}/communications/credits/account`, controller.getAccount);
  router.post(`${base}/communications/credits/topups`, controller.initiateTopup);

  router.get(`${base}/communications/messages`, controller.listMessages);
  router.post(`${base}/communications/messages`, controller.createMessage);
  router.get(`${base}/communications/messages/:messageId`, controller.getMessage);
  router.patch(`${base}/communications/messages/:messageId`, controller.updateMessage);
  router.delete(`${base}/communications/messages/:messageId`, controller.deleteMessage);
  router.post(`${base}/communications/messages/estimate`, controller.estimateCost);
  router.post(`${base}/communications/messages/:messageId/send`, controller.sendMessage);

  return router;
}
