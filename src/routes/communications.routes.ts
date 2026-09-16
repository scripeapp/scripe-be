import express from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { communicationsSchemas } from "../types/communications.schemas";
import { communicationsController } from "../controllers/communications.controller";
import { withSupabase } from "../types/http";

const router = express.Router();

// ============================================================================
// Domains
// ============================================================================

// List all domains
router.get(
  "/domains",
  authenticateUser,
  requirePermission("communications.domain.read"),
  withSupabase(communicationsController.getDomains.bind(communicationsController))
);

// Add new domain
router.post(
  "/domains",
  authenticateUser,
  requirePermission("communications.domain.create"),
  validateRequest(communicationsSchemas.addDomain, "body"),
  withSupabase(communicationsController.addDomain.bind(communicationsController))
);

// Verify domain DNS records
router.post(
  "/domains/:id/verify",
  authenticateUser,
  requirePermission("communications.domain.read"),
  validateRequest(communicationsSchemas.domainIdParam, "params"),
  withSupabase(communicationsController.verifyDomain.bind(communicationsController))
);

// Delete domain
router.delete(
  "/domains/:id",
  authenticateUser,
  requirePermission("communications.domain.delete"),
  validateRequest(communicationsSchemas.domainIdParam, "params"),
  withSupabase(communicationsController.deleteDomain.bind(communicationsController))
);

// ============================================================================
// Senders
// ============================================================================

// List all senders
router.get(
  "/senders",
  authenticateUser,
  requirePermission("communications.sender.read"),
  withSupabase(communicationsController.getSenders.bind(communicationsController))
);

// Get default sender
router.get(
  "/senders/default",
  authenticateUser,
  requirePermission("communications.sender.read"),
  withSupabase(communicationsController.getDefaultSender.bind(communicationsController))
);

// Get single sender
router.get(
  "/senders/:id",
  authenticateUser,
  requirePermission("communications.sender.read"),
  validateRequest(communicationsSchemas.senderIdParam, "params"),
  withSupabase(communicationsController.getSender.bind(communicationsController))
);

// Create sender
router.post(
  "/senders",
  authenticateUser,
  requirePermission("communications.sender.create"),
  validateRequest(communicationsSchemas.createSender, "body"),
  withSupabase(communicationsController.createSender.bind(communicationsController))
);

// Update sender
router.patch(
  "/senders/:id",
  authenticateUser,
  requirePermission("communications.sender.update"),
  validateRequest(communicationsSchemas.senderIdParam, "params"),
  validateRequest(communicationsSchemas.updateSender, "body"),
  withSupabase(communicationsController.updateSender.bind(communicationsController))
);

// Set sender as default
router.post(
  "/senders/:id/default",
  authenticateUser,
  requirePermission("communications.sender.update"),
  validateRequest(communicationsSchemas.senderIdParam, "params"),
  withSupabase(communicationsController.setDefaultSender.bind(communicationsController))
);

// Delete sender
router.delete(
  "/senders/:id",
  authenticateUser,
  requirePermission("communications.sender.delete"),
  validateRequest(communicationsSchemas.senderIdParam, "params"),
  withSupabase(communicationsController.deleteSender.bind(communicationsController))
);

export default router;
