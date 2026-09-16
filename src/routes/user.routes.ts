import express from "express";
import multer from "multer";
import {
  authenticateUser,
  authenticateOptional,
} from "../middleware/supabase-auth-middleware";
import { userController } from "../controllers/user.controller";
import { addressController } from "../controllers/address.controller";
import { withSupabase } from "../types/http";
import { validateRequest } from "../middleware/validation.middleware";
import { z } from "zod";
import { addressSchemas } from "../types/address.schemas";
import upload from "../middleware/upload.middleware";

const router = express.Router();

// Validation schemas
const updatePreferencesSchema = z.object({
  last_active_store_id: z.string().uuid().nullable().optional(),
  last_active_publication_id: z.string().uuid().nullable().optional(),
  timezone: z.string().optional(),
  currency: z.string().optional(),
  locale: z.string().optional(),
  theme: z.enum(["light", "dark", "system"]).optional(),
  onboarding_role: z.enum(["consumer", "creator"]).optional(),
  onboarding_completed: z.boolean().optional(),
  onboarding_intent: z.string().nullable().optional(),
  onboarding_interests: z.array(z.string()).optional(),
  tipping_enabled: z.boolean().optional(),
  notifications: z.any().optional(),
});

const userIdParamSchema = z.object({
  userId: z.string().uuid(),
});

const updateEmailSchema = z.object({
  email: z.string().email(),
});

const updatePasswordSchema = z.object({
  oldPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

// ============================================================================
// User Profile
// ============================================================================

// Get user tipping status + business subaccount for profile/post tip buttons
router.get(
  "/profile/:userId/tipping",
  authenticateOptional,
  validateRequest(userIdParamSchema, "params"),
  withSupabase(userController.getUserTippingInfo.bind(userController)),
);

// Get user profile data (aggregated content)
router.get(
  "/profile/:userId",
  authenticateOptional,
  validateRequest(userIdParamSchema, "params"),
  withSupabase(userController.getUserProfile.bind(userController)),
);

// Get user profile by username
router.get(
  "/profile/handle/:username",
  authenticateOptional, // Using authenticateOptional to allow public access.
  withSupabase(userController.getUserProfileByUsername.bind(userController)),
);

// Get public activity for a user (events attended, subscriptions, purchases)
router.get(
  "/profile/handle/:username/activity",
  authenticateOptional,
  withSupabase(userController.getUserActivityByUsername.bind(userController)),
);

// Update user profile details
router.patch(
  "/profile",
  authenticateUser,
  withSupabase(userController.updateProfile.bind(userController)),
);

router.patch(
  "/email",
  authenticateUser,
  validateRequest(updateEmailSchema, "body"),
  withSupabase(userController.updateEmail.bind(userController)),
);

router.patch(
  "/password",
  authenticateUser,
  validateRequest(updatePasswordSchema, "body"),
  withSupabase(userController.updatePassword.bind(userController)),
);

// Upload profile avatar
router.post(
  "/profile/avatar",
  authenticateUser,
  upload.single("file"),
  upload.single("file"),
  withSupabase(userController.uploadAvatar.bind(userController)),
);

router.post(
  "/profile/banner",
  authenticateUser,
  upload.single("file"),
  withSupabase(userController.uploadBanner.bind(userController)),
);

// ============================================================================
// User Preferences
// ============================================================================

// Get user preferences
router.get(
  "/activation-guide",
  authenticateUser,
  withSupabase(userController.getActivationGuide.bind(userController)),
);

router.get(
  "/preferences",
  authenticateUser,
  withSupabase(userController.getUserPreferences.bind(userController)),
);

// Update user preferences
router.patch(
  "/preferences",
  authenticateUser,
  validateRequest(updatePreferencesSchema, "body"),
  withSupabase(userController.updateUserPreferences.bind(userController)),
);

// ============================================================================
// User Saved Addresses
// ============================================================================

// List saved addresses
router.get(
  "/addresses",
  authenticateUser,
  withSupabase(addressController.listAddresses.bind(addressController)),
);

// Create new address
router.post(
  "/addresses",
  authenticateUser,
  validateRequest(addressSchemas.createAddress, "body"),
  withSupabase(addressController.createAddress.bind(addressController)),
);

// Update address
router.patch(
  "/addresses/:id",
  authenticateUser,
  validateRequest(addressSchemas.addressId, "params"),
  validateRequest(addressSchemas.updateAddress, "body"),
  withSupabase(addressController.updateAddress.bind(addressController)),
);

// Delete address
router.delete(
  "/addresses/:id",
  authenticateUser,
  validateRequest(addressSchemas.addressId, "params"),
  withSupabase(addressController.deleteAddress.bind(addressController)),
);

// Set default address
router.patch(
  "/addresses/:id/default",
  authenticateUser,
  validateRequest(addressSchemas.addressId, "params"),
  withSupabase(addressController.setDefaultAddress.bind(addressController)),
);

// ============================================================================
// NDPR — User Data Rights (self-service)
// ============================================================================

// Submit a data rights request (access, deletion, portability, rectification, objection)
router.post(
  "/ndpr/request",
  authenticateUser,
  withSupabase(userController.submitNdprRequest.bind(userController)),
);

// List the authenticated user's own requests
router.get(
  "/ndpr/requests",
  authenticateUser,
  withSupabase(userController.listMyNdprRequests.bind(userController)),
);

export default router;
