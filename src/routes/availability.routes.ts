import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { availabilityController } from "../controllers/availability.controller";
import { storeSchemas } from "../types/store.schemas";
import { supabase } from "../config/supabase";

const router = Router();

// ============================================================================
// Resolution & Validation (Public - No auth required)
// ============================================================================

router.get(
  "/check/:productId",
  validateRequest(storeSchemas.checkAvailability, "params"),
  (req: any, res) => {
    req.supabase = supabase;
    return availabilityController.checkAvailability(req, res);
  }
);

router.get(
  "/check-store/:slug",
  (req: any, res) => {
    req.supabase = supabase;
    return availabilityController.checkStoreAvailability(req, res);
  }
);

router.get(
  "/slots",
  (req: any, res) => {
    req.supabase = supabase;
    return availabilityController.getAvailableSlots(req, res);
  }
);

router.get(
  "/public/:profileId",
  (req: any, res) => {
    req.supabase = supabase;
    return availabilityController.getPublicProfile(req, res);
  }
);

// ============================================================================
// Profile Management (Authenticated + Permission Protected)
// ============================================================================

router.get(
  "/",
  authenticateUser,
  requirePermission("availability.read"),
  validateRequest(storeSchemas.getAvailabilityProfiles, "query"),
  availabilityController.listProfiles.bind(availabilityController)
);

router.post(
  "/",
  authenticateUser,
  requirePermission("availability.create"),
  validateRequest(storeSchemas.createAvailabilityProfile, "body"),
  availabilityController.createProfile.bind(availabilityController)
);

router.get(
  "/:id",
  authenticateUser,
  requirePermission("availability.read"),
  validateRequest(storeSchemas.duplicateAvailabilityProfile, "params"),
  availabilityController.getProfile.bind(availabilityController)
);

router.patch(
  "/:id",
  authenticateUser,
  requirePermission("availability.update"),
  validateRequest(storeSchemas.updateAvailabilityProfile, "body"),
  availabilityController.updateProfile.bind(availabilityController)
);

router.post(
  "/:id/duplicate",
  authenticateUser,
  requirePermission("availability.create"),
  validateRequest(storeSchemas.duplicateAvailabilityProfile, "params"),
  availabilityController.duplicateProfile.bind(availabilityController)
);

router.delete(
  "/:id",
  authenticateUser,
  requirePermission("availability.delete"),
  validateRequest(storeSchemas.deleteAvailabilityProfile, "params"),
  availabilityController.deleteProfile.bind(availabilityController)
);



export default router;
