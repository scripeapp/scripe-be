import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { IntegrationsController } from "./integrations.controller.js";
import { IntegrationsService } from "./integrations.service.js";

/** The signed-in person's own integrations; connecting Google happens through Better Auth's link-social flow. */
export function createIntegrationsRouter(): Router {
  const router = Router();
  const controller = new IntegrationsController(new IntegrationsService(getDatabase()));
  const base = "/api/me/integrations";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.patch(`${base}/google-calendar`, controller.updateGoogleCalendar);
  router.delete(`${base}/google-calendar`, controller.disconnectGoogleCalendar);

  return router;
}
