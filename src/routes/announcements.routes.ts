import express from "express";
import { authenticateUser, managerAuthMiddleware } from "../middleware/supabase-auth-middleware";
import { createAnnouncement, getAnnouncements, deleteAnnouncement } from "../controllers/announcement.controller";
import { withSupabase } from "src/types/http";

const router = express.Router();


// Create a new announcement (managers only)
router.post("/",
  authenticateUser,
  managerAuthMiddleware as unknown as express.RequestHandler,
  withSupabase(createAnnouncement)
);

// Get all announcements for an entity
// Uses query parameters: ?entityId=xxx&entityType=event
router.get("/", getAnnouncements);

// Delete an announcement (managers only)
router.delete("/:announcementId",
  authenticateUser,
  managerAuthMiddleware as unknown as express.RequestHandler,
  withSupabase(deleteAnnouncement)
);

export default router;
