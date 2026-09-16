/**
 * Form Routes
 * Handles Hilaq Forms API endpoints.
 */

import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";
import { supabase } from "../config/supabase";
import { formController } from "../controllers/form.controller";

const router = Router();

// ============================================================================
// Organizer Endpoints (Authenticated)
// ============================================================================

// Create form
router.post(
  "/",
  authenticateUser,
  requirePermission("forms.create"),
  withSupabase(formController.createForm.bind(formController)),
);

// List all forms for business
router.get(
  "/",
  authenticateUser,
  requirePermission("forms.read"),
  withSupabase(formController.listForms.bind(formController)),
);

// Get single form
router.get(
  "/:formId",
  authenticateUser,
  requirePermission("forms.read"),
  withSupabase(formController.getForm.bind(formController)),
);

// Update form
router.patch(
  "/:formId",
  authenticateUser,
  requirePermission("forms.update"),
  withSupabase(formController.updateForm.bind(formController)),
);

// Publish / unpublish
router.patch(
  "/:formId/publish",
  authenticateUser,
  requirePermission("forms.update"),
  withSupabase(formController.publishForm.bind(formController)),
);

// Delete form
router.delete(
  "/:formId",
  authenticateUser,
  requirePermission("forms.delete"),
  withSupabase(formController.deleteForm.bind(formController)),
);

// Get submissions for a form
router.get(
  "/:formId/submissions",
  authenticateUser,
  requirePermission("forms.read"),
  withSupabase(formController.getSubmissions.bind(formController)),
);

// ============================================================================
// Public Endpoints (No Auth)
// These must come BEFORE /:formId to avoid route conflicts.
// ============================================================================

// Get public form by slug
router.get("/public/:slug", (req, res) => {
  (req as any).supabase = supabase;
  return formController.getPublicForm(req, res);
});

// Initiate payment for form submission (no DB write — webhook handles it)
router.post("/public/:slug/pay", (req, res) => {
  (req as any).supabase = supabase;
  return formController.initiateFormPayment(req, res);
});

// Submit a free form directly (no payment required)
router.post("/public/:slug/submit", (req, res) => {
  (req as any).supabase = supabase;
  return formController.submitFreeForm(req, res);
});

// Submission lookup by payment reference (for success page polling)
router.get("/public/submission/ref/:reference", (req, res) => {
  (req as any).supabase = supabase;
  return formController.getSubmissionByReference(req, res);
});

export default router;
