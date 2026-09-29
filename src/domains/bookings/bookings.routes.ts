import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { BookingsController } from "./bookings.controller.js";
import { BookingsService } from "./bookings.service.js";

export function createBookingsRouter(): Router {
  const router = Router();
  const controller = new BookingsController(new BookingsService(getDatabase()));

  // Public storefront reservation (shoppers are not authenticated members).
  router.post("/api/store/bookings/reserve", controller.reserve);

  // Dashboard reads/writes require an authenticated business member.
  router.get("/api/store/bookings", requireAuth, controller.list);
  router.get("/api/store/bookings/slots", requireAuth, controller.slots);
  router.patch("/api/store/bookings/:bookingId/status", requireAuth, controller.updateStatus);

  return router;
}