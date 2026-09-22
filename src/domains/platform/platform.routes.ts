import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PlatformController } from "./platform.controller.js";
import { PlatformService } from "./platform.service.js";

export function createPlatformRouter(): Router {
  const router = Router();
  const controller = new PlatformController(new PlatformService(getDatabase()));

  const administratorsBase = "/api/platform/administrators";
  const alertsBase = "/api/platform/alerts";
  const announcementsBase = "/api/platform/announcements";

  router.use(administratorsBase, requireAuth);
  router.get(administratorsBase, controller.listAdministrators);
  router.post(administratorsBase, controller.createAdministrator);
  router.patch(`${administratorsBase}/:administratorId`, controller.updateAdministrator);
  router.delete(`${administratorsBase}/:administratorId`, controller.deactivateAdministrator);

  router.use(alertsBase, requireAuth);
  router.get(alertsBase, controller.listAlerts);
  router.get(`${alertsBase}/unread-count`, controller.unreadAlertCount);
  router.patch(`${alertsBase}/read`, controller.markAlertsRead);

  router.use(announcementsBase, requireAuth);
  router.get(announcementsBase, controller.listAnnouncements);
  router.post(announcementsBase, controller.createAnnouncement);
  router.patch(`${announcementsBase}/:announcementId`, controller.updateAnnouncement);
  router.delete(`${announcementsBase}/:announcementId`, controller.deleteAnnouncement);

  return router;
}
