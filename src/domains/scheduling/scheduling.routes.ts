import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { SchedulingController } from "./scheduling.controller.js";
import { SchedulingService } from "./scheduling.service.js";

export function createSchedulingRouter(): Router {
  const router = Router();
  const controller = new SchedulingController(new SchedulingService(getDatabase()));

  // Availability profiles (reusable weekly schedules for service bookings).
  router.get("/api/availability", requireAuth, controller.listAvailability);
  router.post("/api/availability", requireAuth, controller.createAvailability);
  router.post("/api/availability/:id/duplicate", requireAuth, controller.duplicateAvailability);
  router.patch("/api/availability/:id", requireAuth, controller.updateAvailability);
  router.delete("/api/availability/:id", requireAuth, controller.deleteAvailability);

  // Bookable event types.
  router.get("/api/scheduling/event-types", requireAuth, controller.listEventTypes);
  router.post("/api/scheduling/event-types", requireAuth, controller.createEventType);
  router.patch("/api/scheduling/event-types/:id", requireAuth, controller.updateEventType);
  router.delete("/api/scheduling/event-types/:id", requireAuth, controller.deleteEventType);

  return router;
}
