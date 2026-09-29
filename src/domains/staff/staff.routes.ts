import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { StaffController } from "./staff.controller.js";
import { StaffService } from "./staff.service.js";

export function createStaffRouter(): Router {
  const router = Router();
  const controller = new StaffController(new StaffService(getDatabase()));
  const base = "/api/businesses/:businessId";

  router.use(base, requireAuth);

  router.get(`${base}/staff`, controller.list);
  router.post(`${base}/staff`, controller.create);
  router.patch(`${base}/staff/:staffId`, controller.update);
  router.delete(`${base}/staff/:staffId`, controller.remove);
  router.put(`${base}/staff/:staffId/services`, controller.setServices);
  router.put(`${base}/staff/:staffId/schedule`, controller.setSchedule);

  router.get(`${base}/schedule-exceptions`, controller.listExceptions);
  router.post(`${base}/schedule-exceptions`, controller.createException);
  router.delete(`${base}/schedule-exceptions/:exceptionId`, controller.removeException);

  router.get(`${base}/staff/commission-report`, controller.commissionReport);

  return router;
}
