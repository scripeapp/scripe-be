import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

export function createNotificationsRouter(): Router {
  const router = Router();
  const controller = new NotificationsController(new NotificationsService(getDatabase()));
  const base = "/api/me/notifications";
  const preferencesBase = "/api/me/notification-preferences";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.get(`${base}/unread-count`, controller.unreadCount);
  router.patch(`${base}/:notificationId`, controller.update);

  router.use(preferencesBase, requireAuth);
  router.get(preferencesBase, controller.listPreferences);
  router.put(`${preferencesBase}/:type/:channel`, controller.setPreference);

  return router;
}
