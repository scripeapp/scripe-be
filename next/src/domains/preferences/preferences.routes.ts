import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PreferencesController } from "./preferences.controller.js";
import { PreferencesService } from "./preferences.service.js";

export function createPreferencesRouter(): Router {
  const router = Router();
  const controller = new PreferencesController(new PreferencesService(getDatabase()));
  const base = "/api/me/preferences";

  router.use(base, requireAuth);
  router.get(base, controller.get);
  router.patch(base, controller.update);

  return router;
}
