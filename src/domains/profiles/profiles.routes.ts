import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ProfilesController } from "./profiles.controller.js";
import { ProfilesService } from "./profiles.service.js";

export function createProfilesRouter(): Router {
  const router = Router();
  const profilesService = new ProfilesService(getDatabase());
  const profilesController = new ProfilesController(profilesService);

  router.get("/api/me", requireAuth, profilesController.getCurrentUser);
  router.patch("/api/me", requireAuth, profilesController.updateCurrentUser);
  router.patch("/api/me/avatar", requireAuth, profilesController.setAvatar);
  router.get("/api/users/:userId/avatar", profilesController.getAvatar);

  return router;
}
