import express from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { authenticateCheckinOrUser } from "../middleware/checkin-auth.middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { getUserPublications } from "../controllers/pubsMgr.controller";
import {
  getUserEvents,
  getEvent,
  getAttendees,
  checkInAttendee,
  updateSalesStatus,
  createCashPurchase,
  getDashboardStats,
  getDashboardAttention,
} from "../controllers/eventsMgr.controller";
import { duplicateEvent } from "../controllers/events.controller";
import { withSupabase } from "../types/http";
import { checkinController } from "../controllers/checkin.controller";
import { resendTicketEmail } from "../controllers/tickets.controller";

const router = express.Router();

// Dashboard stats
router.get(
  "/stats",
  authenticateUser,
  requirePermission("analytics.read"),
  withSupabase(getDashboardStats),
);

// Dashboard attention panel
router.get("/attention", authenticateUser, withSupabase(getDashboardAttention));

router.get(
  "/publications",
  authenticateUser,
  requirePermission("publication.post.read"),
  withSupabase(getUserPublications),
);

router.get(
  "/events",
  authenticateUser,
  requirePermission("event.read"),
  withSupabase(getUserEvents),
);

router.get(
  "/events/:id",
  authenticateUser,
  requirePermission("event.read"),
  withSupabase(getEvent),
);

// Duplicate an event into a new draft
router.post(
  "/events/:id/duplicate",
  authenticateUser,
  requirePermission("event.create"),
  withSupabase(duplicateEvent),
);

router.get(
  "/events/:id/attendees",
  authenticateCheckinOrUser,
  withSupabase(getAttendees),
);

// Check in an attendee (accepts both user session and check-in token)
// Permission check moved into controller to support both auth paths
router.put(
  "/events/:id/attendees/checkin",
  authenticateCheckinOrUser,
  withSupabase(checkInAttendee),
);

// Check whether an access code is active for an event
router.get(
  "/events/:id/checkin-code/status",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(checkinController.getCodeStatus.bind(checkinController)),
);

// Generate / rotate an event check-in access code
router.post(
  "/events/:id/checkin-code",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(checkinController.generateCode.bind(checkinController)),
);

// Disable the check-in access code
router.delete(
  "/events/:id/checkin-code",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(checkinController.revokeCode.bind(checkinController)),
);

// Resend ticket email
router.post(
  "/events/:id/attendees/:attendeeId/resend-ticket",
  authenticateUser,
  // Permission handled in controller
  withSupabase(resendTicketEmail),
);

// Update sales status of an event
router.put(
  "/events/:id/sales-status",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(updateSalesStatus),
);

// Create cash purchase order
router.post(
  "/events/:id/orders/cash",
  authenticateUser,
  requirePermission("event.order.create"),
  withSupabase(createCashPurchase),
);

export default router;
