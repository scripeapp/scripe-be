import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PosController } from "./pos.controller.js";
import { PosService } from "./pos.service.js";

/** Till endpoints: pricing preview, charging a ticket, and today's open bookings. */
export function createPosRouter(): Router {
  const router = Router();
  const controller = new PosController(new PosService(getDatabase()));
  const base = "/api/store";
  router.use(base, requireAuth);
  router.get(`${base}/pos/bookings`, controller.bookings);
  router.post(`${base}/pos/order/preview`, controller.preview);
  router.post(`${base}/pos/order`, controller.charge);
  return router;
}