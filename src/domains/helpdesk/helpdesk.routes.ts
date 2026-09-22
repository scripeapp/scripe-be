import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { HelpdeskController } from "./helpdesk.controller.js";
import { HelpdeskService } from "./helpdesk.service.js";

export function createHelpdeskRouter(): Router {
  const router = Router();
  const controller = new HelpdeskController(new HelpdeskService(getDatabase()));
  const base = "/api/support/tickets";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:ticketId`, controller.get);
  router.post(`${base}/:ticketId/replies`, controller.reply);

  return router;
}
