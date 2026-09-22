import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { JobsController } from "./jobs.controller.js";
import { JobsService } from "./jobs.service.js";

export function createJobsRouter(): Router {
  const router = Router();
  const controller = new JobsController(new JobsService(getDatabase()));
  const base = "/api/jobs";
  router.use(base, requireAuth);

  router.get(base, controller.listJobs);
  router.get(`${base}/:jobId`, controller.getJob);
  router.post(`${base}/:jobId/rerun`, controller.rerunJob);
  router.post(`${base}/:jobId/cancel`, controller.cancelJob);

  return router;
}
