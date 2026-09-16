import express from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { withSupabase } from "../types/http";
import {
  getCertificateConfig,
  upsertCertificateConfig,
  releaseCertificates,
  listEventCertificates,
  revokeCertificate,
  verifyCertificate,
  downloadCertificatePdf,
  processScheduledRelease,
} from "../controllers/certificate.controller";

const router = express.Router();

// ============================================================================
// PUBLIC ROUTES (no auth — guarded by non-guessable verify code)
// ============================================================================

// Public verification (JSON) — keep before /:verifyCode/pdf is fine (distinct path)
router.get("/verify/:verifyCode", withSupabase(verifyCertificate));

// Stream the certificate PDF (generated on demand, never stored)
router.get("/:verifyCode/pdf", withSupabase(downloadCertificatePdf));

// QStash worker for scheduled auto-release (signature-verified in controller)
router.post("/process-release", processScheduledRelease);

// ============================================================================
// PRIVATE ROUTES (business members)
// ============================================================================

router.get(
  "/config/:eventId",
  authenticateUser,
  requirePermission("event.read"),
  withSupabase(getCertificateConfig),
);

router.put(
  "/config/:eventId",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(upsertCertificateConfig),
);

router.post(
  "/release/:eventId",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(releaseCertificates),
);

router.get(
  "/event/:eventId",
  authenticateUser,
  requirePermission("event.read"),
  withSupabase(listEventCertificates),
);

router.post(
  "/:id/revoke",
  authenticateUser,
  requirePermission("event.update"),
  withSupabase(revokeCertificate),
);

export default router;
