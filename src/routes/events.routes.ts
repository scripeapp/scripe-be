import express from "express";
import upload from "../middleware/upload.middleware";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { authenticateCheckinOrUser } from "../middleware/checkin-auth.middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import {
  createEvent,
  checkEventUrl,
  getAllEvents,
  getEvent,
  updateEvent,
  attendEvent,
  checkIn,
  uploadEventImage,
  deleteEvent,
  getPublicOrderByReference,
  getPublicTicketsByOrderId,
  getPublicEventCalendar,
  initiateEventPayment,
  quoteEventPricing,
} from "../controllers/events.controller";
import { withSupabase } from "../types/http";
import {
  answerEventQuestion,
  createEventQuestion,
  deleteEventQuestion,
  getEventQuestions,
  toggleEventQuestionVisibility,
} from "../controllers/question.controller";
import { validateAttendee } from "../controllers/eventsMgr.controller";

const router = express.Router();

// ============================================================================
// PUBLIC ROUTES (No auth required - for event discovery)
// ============================================================================

// List all public events
router.get("/", withSupabase(getAllEvents));

// Check whether an event_url slug is already taken (must be before /:id)
router.get("/check-url", withSupabase(checkEventUrl));

// Get event details
router.get("/:id", withSupabase(getEvent));

// Get public order by reference
router.get("/public/order/:reference", withSupabase(getPublicOrderByReference));

// Get public tickets by order ID
router.get("/public/tickets/:orderId", withSupabase(getPublicTicketsByOrderId));

// ICS calendar download for an event
router.get("/public/event/:eventId/calendar", withSupabase(getPublicEventCalendar));

// Initiate server-side Paystack payment for event tickets (no auth required)
router.post("/:id/initiate-payment", withSupabase(initiateEventPayment));
router.post("/:id/quote", withSupabase(quoteEventPricing));

// ============================================================================
// PROTECTED ROUTES (Require authentication + permission)
// ============================================================================

// Create a new event
router.post(
  "/create",
  upload.single("imageFile"),
  authenticateUser,
  requirePermission("event.create"),
  withSupabase(createEvent),
);

// Update an event
router.put(
  "/update/:id",
  upload.single("imageFile"),
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(updateEvent),
);

// Delete an event
router.delete(
  "/:id",
  authenticateUser,
  requirePermission("event.delete"),
  withSupabase(deleteEvent),
);

// Attend an event
router.post("/:id/attend", authenticateUser, withSupabase(attendEvent));

// Check-in (Attendance)
router.post("/check-in", authenticateUser, withSupabase(checkIn));

// Validate ticket (accepts both user session and check-in token)
router.post(
  "/:id/attendees/validate",
  authenticateCheckinOrUser,
  withSupabase(validateAttendee),
);

// ============================================================================
// EVENT QUESTIONS (Q&A Feature)
// ============================================================================

// Get event questions
router.get(
  "/:eventId/questions",
  authenticateUser,
  requirePermission("event.read"),
  withSupabase(getEventQuestions),
);

// Create a question
router.post(
  "/:eventId/questions",
  upload.single("imageFile"),
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(createEventQuestion),
);

// Answer a question
router.get(
  "/:eventId/questions/:questionId/answer",
  withSupabase(answerEventQuestion),
);

// Toggle question visibility
router.get(
  "/:eventId/questions/:questionId/visibility",
  withSupabase(toggleEventQuestionVisibility),
);

// Delete a question
router.delete(
  "/:eventId/questions/:questionId",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(deleteEventQuestion),
);

// ============================================================================
// STORAGE ROUTES
// ============================================================================
router.post(
  "/upload/image",
  authenticateUser,
  upload.single("file"),
  requirePermission("event.update"),
  withSupabase(uploadEventImage),
);

export default router;
