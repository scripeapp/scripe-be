import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { AuditController } from "./audit.controller.js";
import { AuditService } from "./audit.service.js";

export function createAuditRouter(): Router {
  const router = Router();
  const controller = new AuditController(new AuditService(getDatabase()));
  const base = "/api/businesses/:businessId/audit-events";

  router.use(base, requireAuth);
  router.get(base, controller.list);

  return router;
}
