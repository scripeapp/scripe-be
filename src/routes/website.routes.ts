import express from "express";
import { withSupabase } from "../types/http";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import websiteController from "../controllers/website.controller";
import { validateRequest } from "../middleware/validation.middleware";
import { websiteSchemas } from "../types/website.schemas";
import upload from "../middleware/upload.middleware";

const router = express.Router();

// ============================================================================
// PUBLIC ROUTES
// ============================================================================
router.get("/load", authenticateOptional, withSupabase(websiteController.load));
router.get(
  "/check-subdomain",
  validateRequest(websiteSchemas.checkSubdomain, "query"),
  withSupabase(websiteController.checkSubdomain),
);

// ============================================================================
// PROTECTED ROUTES (Require authentication + permission)
// ============================================================================
router.post(
  "/init",
  authenticateUser,
  requirePermission("website.update"),
  validateRequest(websiteSchemas.init),
  withSupabase(websiteController.init),
);

router.get(
  "/me",
  authenticateUser,
  requirePermission("website.read"),
  withSupabase(websiteController.me),
);

router.post(
  "/save",
  authenticateUser,
  requirePermission("website.update"),
  validateRequest(websiteSchemas.save),
  withSupabase(websiteController.save),
);

router.patch(
  "/publish",
  authenticateUser,
  requirePermission("website.publish"),
  validateRequest(websiteSchemas.publish),
  withSupabase(websiteController.publish),
);

router.patch(
  "/page",
  authenticateUser,
  requirePermission("website.update"),
  validateRequest(websiteSchemas.page),
  withSupabase(websiteController.page),
);

router.patch(
  "/section",
  authenticateUser,
  requirePermission("website.update"),
  validateRequest(websiteSchemas.section),
  withSupabase(websiteController.section),
);

router.patch(
  "/navigation",
  authenticateUser,
  requirePermission("website.update"),
  validateRequest(websiteSchemas.navigation),
  withSupabase(websiteController.updateNavigation),
);

// ============================================================================
// STORAGE ROUTES
// ============================================================================
router.post(
  "/upload/sections",
  authenticateUser,
  upload.single("file"),
  requirePermission("website.update"),
  withSupabase(websiteController.uploadSectionImage.bind(websiteController)),
);

router.post(
  "/upload/logo",
  authenticateUser,
  upload.single("file"),
  requirePermission("website.update"),
  withSupabase(websiteController.uploadLogo.bind(websiteController)),
);

export default router;
