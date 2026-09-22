import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { UploadsController } from "./uploads.controller.js";
import { UploadsService } from "./uploads.service.js";

export function createUploadsRouter(): Router {
  const router = Router();
  const controller = new UploadsController(new UploadsService(getDatabase()));
  const base = "/api/uploads";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:uploadId`, controller.get);
  router.post(`${base}/:uploadId/confirm`, controller.confirm);
  router.delete(`${base}/:uploadId`, controller.remove);

  return router;
}
