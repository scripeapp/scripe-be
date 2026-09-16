import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { withSupabase } from "../types/http";
import { crmController } from "../controllers/crm.controller";
import { crmSchemas } from "../types/crm.schemas";

const router = Router();

// ============================================================================
// Contacts
// ============================================================================

router.get(
  "/contacts",
  authenticateUser,
  requirePermission("crm.contact.read"),
  validateRequest(crmSchemas.getContacts, "query"),
  withSupabase(crmController.getContacts.bind(crmController))
);

router.post(
  "/contacts",
  authenticateUser,
  requirePermission("crm.contact.create"),
  validateRequest(crmSchemas.createContact, "body"),
  withSupabase(crmController.createContact.bind(crmController))
);

router.patch(
  "/contacts/:id",
  authenticateUser,
  requirePermission("crm.contact.update"),
  validateRequest(crmSchemas.contactIdParam, "params"),
  validateRequest(crmSchemas.updateContact, "body"),
  withSupabase(crmController.updateContact.bind(crmController))
);

router.get(
  "/contacts/:id/segments",
  authenticateUser,
  requirePermission("crm.contact.read"),
  validateRequest(crmSchemas.contactIdParam, "params"),
  withSupabase(crmController.getContactSegments.bind(crmController))
);

router.get(
  "/contacts/:id/activities",
  authenticateUser,
  requirePermission("crm.contact.read"),
  validateRequest(crmSchemas.contactIdParam, "params"),
  withSupabase(crmController.getContactActivities.bind(crmController))
);

router.delete(
  "/contacts/:id",
  authenticateUser,
  requirePermission("crm.contact.delete"),
  validateRequest(crmSchemas.contactIdParam, "params"),
  withSupabase(crmController.deleteContact.bind(crmController))
);

router.post(
  "/contacts/bulk",
  authenticateUser,
  requirePermission("crm.contact.create"),
  validateRequest(crmSchemas.bulkContacts, "body"),
  withSupabase(crmController.bulkContacts.bind(crmController))
);

// Import contacts from CSV (bulk upload)
router.post(
  "/contacts/import",
  authenticateUser,
  requirePermission("crm.contact.create"),
  validateRequest(crmSchemas.importContacts, "body"),
  withSupabase(crmController.importContacts.bind(crmController))
);

// ============================================================================
// Segments
// ============================================================================

router.get(
  "/segments",
  authenticateUser,
  requirePermission("crm.segment.read"),
  withSupabase(crmController.getSegments.bind(crmController))
);

router.post(
  "/segments",
  authenticateUser,
  requirePermission("crm.segment.create"),
  validateRequest(crmSchemas.createSegment, "body"),
  withSupabase(crmController.createSegment.bind(crmController))
);

router.post(
  "/segments/preview",
  authenticateUser,
  requirePermission("crm.segment.read"),
  validateRequest(crmSchemas.previewSegment, "body"),
  withSupabase(crmController.previewSegment.bind(crmController))
);

router.patch(
  "/segments/:id",
  authenticateUser,
  requirePermission("crm.segment.update"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  validateRequest(crmSchemas.updateSegment, "body"),
  withSupabase(crmController.updateSegment.bind(crmController))
);

router.delete(
  "/segments/:id",
  authenticateUser,
  requirePermission("crm.segment.delete"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  withSupabase(crmController.deleteSegment.bind(crmController))
);

router.get(
  "/segments/:id/contacts",
  authenticateUser,
  requirePermission("crm.segment.read"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  validateRequest(crmSchemas.getSegmentContacts, "query"),
  withSupabase(crmController.getSegmentContacts.bind(crmController))
);

router.get(
  "/segments/:id/activity",
  authenticateUser,
  requirePermission("crm.segment.read"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  withSupabase(crmController.getSegmentActivity.bind(crmController))
);

router.post(
  "/segments/:id/contacts",
  authenticateUser,
  requirePermission("crm.segment.update"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  validateRequest(crmSchemas.segmentContacts, "body"),
  withSupabase(crmController.addContactsToSegment.bind(crmController))
);

router.delete(
  "/segments/:id/contacts",
  authenticateUser,
  requirePermission("crm.segment.update"),
  validateRequest(crmSchemas.segmentIdParam, "params"),
  validateRequest(crmSchemas.segmentContacts, "body"),
  withSupabase(crmController.removeContactsFromSegment.bind(crmController))
);

// ============================================================================
// Campaigns
// ============================================================================

router.get(
  "/campaigns",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  validateRequest(crmSchemas.getCampaigns, "query"),
  withSupabase(crmController.getCampaigns.bind(crmController))
);

// Validate audience (must be before /:id routes)
router.post(
  "/campaigns/validate-audience",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  validateRequest(crmSchemas.validateAudience, "body"),
  withSupabase(crmController.validateAudience.bind(crmController))
);

router.get(
  "/campaign-credits",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  withSupabase(crmController.getCampaignCredits.bind(crmController))
);

router.post(
  "/campaign-credits/top-up",
  authenticateUser,
  requirePermission("crm.campaign.send"),
  validateRequest(crmSchemas.initializeCampaignCreditTopUp, "body"),
  withSupabase(crmController.initializeCampaignCreditTopUp.bind(crmController))
);

router.get(
  "/campaigns/:id",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  withSupabase(crmController.getCampaign.bind(crmController))
);

router.post(
  "/campaigns",
  authenticateUser,
  requirePermission("crm.campaign.create"),
  validateRequest(crmSchemas.createCampaign, "body"),
  withSupabase(crmController.createCampaign.bind(crmController))
);

router.patch(
  "/campaigns/:id",
  authenticateUser,
  requirePermission("crm.campaign.update"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  validateRequest(crmSchemas.updateCampaign, "body"),
  withSupabase(crmController.updateCampaign.bind(crmController))
);

router.delete(
  "/campaigns/:id",
  authenticateUser,
  requirePermission("crm.campaign.delete"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  withSupabase(crmController.deleteCampaign.bind(crmController))
);

router.post(
  "/campaigns/:id/send",
  authenticateUser,
  requirePermission("crm.campaign.send"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  withSupabase(crmController.sendCampaign.bind(crmController))
);

router.post(
  "/campaigns/:id/retry",
  authenticateUser,
  requirePermission("crm.campaign.send"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  withSupabase(crmController.retryCampaign.bind(crmController))
);

router.post(
  "/campaigns/:id/schedule",
  authenticateUser,
  requirePermission("crm.campaign.update"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  validateRequest(crmSchemas.scheduleCampaign, "body"),
  withSupabase(crmController.scheduleCampaign.bind(crmController))
);

router.get(
  "/campaigns/:id/recipients",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  validateRequest(crmSchemas.getCampaignRecipients, "query"),
  withSupabase(crmController.getCampaignRecipients.bind(crmController))
);

router.get(
  "/campaigns/:id/stats",
  authenticateUser,
  requirePermission("crm.campaign.read"),
  validateRequest(crmSchemas.campaignIdParam, "params"),
  withSupabase(crmController.getCampaignStats.bind(crmController))
);

// ============================================================================
// Resources (Templates & Media)
// ============================================================================

import upload from "../middleware/upload.middleware";

router.post(
  "/upload/image",
  authenticateUser,
  // requirePermission("crm.campaign.create"), // Optional: restrict to campaign creators
  upload.single("file"),
  withSupabase(crmController.uploadImage.bind(crmController))
);

router.get(
  "/templates",
  authenticateUser,
  withSupabase(crmController.getTemplates.bind(crmController))
);

export default router;
