import { Router } from "express";
import { supabase } from "../config/supabase";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { withSupabase } from "../types/http";
import {
  seedDefaults,
  listEventTypes,
  getEventType,
  createEventType,
  updateEventType,
  deleteEventType,
  getPublicEventType,
  getPublicSlots,
  createBooking,
  listBookings,
  confirmBooking,
  cancelBooking,
  checkInBooking,
  deleteBooking,
  cancelByToken,
  verifySchedulingPayment,
} from "../controllers/scheduling.controller";

const router = Router();

// ============================================================================
// Public (no auth)
// ============================================================================

// GET /scheduling/public/:businessSlug/:slug
router.get("/public/:businessSlug/:slug", (req: any, res) => {
  req.supabase = supabase;
  return getPublicEventType(req, res);
});

// GET /scheduling/public/:businessSlug/:slug/slots?date=YYYY-MM-DD
router.get("/public/:businessSlug/:slug/slots", (req: any, res) => {
  req.supabase = supabase;
  return getPublicSlots(req, res);
});

// GET /scheduling/bookings/verify-payment (public — called from payment confirm page)
router.get("/bookings/verify-payment", (req: any, res) => {
  req.supabase = supabase;
  return verifySchedulingPayment(req, res);
});

// POST /scheduling/bookings
router.post("/bookings", (req: any, res) => {
  req.supabase = supabase;
  return createBooking(req, res);
});

// POST /scheduling/bookings/cancel-by-token (public — attendee self-cancel)
router.post("/bookings/cancel-by-token", (req: any, res) => {
  req.supabase = supabase;
  return cancelByToken(req, res);
});

// ============================================================================
// Authenticated — Event Types
// ============================================================================

router.post("/seed-defaults", authenticateUser, withSupabase(seedDefaults));
router.get("/event-types", authenticateUser, withSupabase(listEventTypes));
router.post("/event-types", authenticateUser, withSupabase(createEventType));
router.get("/event-types/:id", authenticateUser, withSupabase(getEventType));
router.patch("/event-types/:id", authenticateUser, withSupabase(updateEventType));
router.delete("/event-types/:id", authenticateUser, withSupabase(deleteEventType));

// ============================================================================
// Authenticated — Bookings (host view)
// ============================================================================

router.get("/bookings", authenticateUser, withSupabase(listBookings));
router.patch("/bookings/:id/confirm", authenticateUser, withSupabase(confirmBooking));
router.patch("/bookings/:id/cancel", authenticateUser, withSupabase(cancelBooking));
router.patch("/bookings/:id/check-in", authenticateUser, withSupabase(checkInBooking));
router.delete("/bookings/:id", authenticateUser, withSupabase(deleteBooking));

export default router;
