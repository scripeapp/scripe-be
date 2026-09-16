import { Response, Request } from "express";
import { Receiver } from "@upstash/qstash";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { CertificateService } from "../services/certificate.service";
import { emailService } from "../services/email.service";
import supabaseAdmin from "../config/supabaseAdmin";
import { upsertCertificateConfigSchema } from "../types/certificate.schemas";

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  process.env.WEB_URL ||
  "https://hilaq.com"
).replace(/\/+$/, "");

const certUrl = (verifyCode: string) =>
  `${FRONTEND_URL}/event-certificates/${verifyCode}`;

/** Admin (service-role) service for public + worker paths. */
function adminService(): CertificateService {
  if (!supabaseAdmin) {
    throw new Error("Service-role client unavailable");
  }
  return new CertificateService(supabaseAdmin);
}

/**
 * @desc   Get certificate config for an event
 * @access private (event.read)
 * @route  GET /api/event-certificates/config/:eventId
 */
export const getCertificateConfig = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const service = new CertificateService(req.supabase!);
    const config = await service.getConfig(req.params.eventId);
    return ApiResponse.success(res, "Certificate config fetched", config);
  } catch (error: any) {
    console.error("[Certificate] getConfig error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   Create/update certificate config for an event
 * @access private (event.update)
 * @route  PUT /api/event-certificates/config/:eventId
 */
export const upsertCertificateConfig = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const businessId =
      (req as any).businessId ||
      req.body.business_id ||
      (req.query.business_id as string) ||
      null;

    const input = upsertCertificateConfigSchema.parse(req.body);
    const service = new CertificateService(req.supabase!);
    const config = await service.upsertConfig(
      req.params.eventId,
      businessId,
      input,
    );

    // Reconcile the auto-release schedule (best-effort; don't fail the save).
    void service.syncAutoReleaseSchedule(req.params.eventId).catch((err) => {
      console.error("[Certificate] syncAutoReleaseSchedule error:", err);
    });

    return ApiResponse.success(res, "Certificate config saved", config);
  } catch (error: any) {
    console.error("[Certificate] upsertConfig error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   Manually release certificates for an event (issue + notify)
 * @access private (event.update)
 * @route  POST /api/event-certificates/release/:eventId
 */
export const releaseCertificates = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const service = new CertificateService(req.supabase!);
    const result = await service.release(req.params.eventId);

    // Notify newly-issued recipients (best-effort; don't block the response).
    void notifyRecipients(result.certificates);

    return ApiResponse.success(res, "Certificates released", {
      issued: result.issued,
      skipped: result.skipped,
    });
  } catch (error: any) {
    console.error("[Certificate] release error:", error);
    return ApiResponse.error(res, error?.message || "Failed to release", 400);
  }
};

/**
 * @desc   List certificates issued for an event (organizer)
 * @access private (event.read)
 * @route  GET /api/event-certificates/event/:eventId
 */
export const listEventCertificates = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const service = new CertificateService(req.supabase!);
    const certs = await service.listCertificates(req.params.eventId);
    return ApiResponse.success(res, "Certificates fetched", certs);
  } catch (error: any) {
    console.error("[Certificate] list error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   Revoke a certificate
 * @access private (event.update)
 * @route  POST /api/event-certificates/:id/revoke
 */
export const revokeCertificate = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const service = new CertificateService(req.supabase!);
    await service.revoke(req.params.id);
    return ApiResponse.success(res, "Certificate revoked", null);
  } catch (error: any) {
    console.error("[Certificate] revoke error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   Public verification of a certificate by code
 * @access public
 * @route  GET /api/event-certificates/verify/:verifyCode
 */
export const verifyCertificate = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = adminService();
    const cert = await service.getPublicByVerifyCode(req.params.verifyCode);
    if (!cert) {
      return ApiResponse.error(res, "Certificate not found", 404);
    }
    return ApiResponse.success(res, "Certificate fetched", cert);
  } catch (error: any) {
    console.error("[Certificate] verify error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   Stream the certificate PDF (generated on demand, not stored)
 * @access public (by non-guessable verify code)
 * @route  GET /api/event-certificates/:verifyCode/pdf
 */
export const downloadCertificatePdf = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const service = adminService();
    const pdf = await service.renderPdf(req.params.verifyCode);
    if (!pdf) {
      return ApiResponse.error(res, "Certificate not available", 404);
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="certificate-${req.params.verifyCode}.pdf"`,
    );
    return res.send(Buffer.from(pdf));
  } catch (error: any) {
    console.error("[Certificate] download error:", error);
    return ApiResponse.serverError(res, error?.message);
  }
};

/**
 * @desc   QStash worker: auto-release certificates for an event after end.
 * @access QStash (signature-verified)
 * @route  POST /api/event-certificates/process-release
 */
export const processScheduledRelease = async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    const signature = req.headers["upstash-signature"] as string | undefined;
    if (!signature) return res.status(401).json({ error: "Unauthorized" });
    try {
      const receiver = new Receiver({
        currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
        nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
      });
      const isValid = await receiver.verify({
        signature,
        body: JSON.stringify(req.body),
      });
      if (!isValid) return res.status(401).json({ error: "Unauthorized" });
    } catch {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }

  try {
    const { eventId } = req.body as { eventId: string };
    if (!eventId) return res.status(400).json({ error: "eventId required" });

    const service = adminService();
    const config = await service.getConfig(eventId);
    // Only auto-release if still enabled, in auto mode, and not already released.
    if (!config || !config.enabled || config.release_mode !== "auto") {
      return res.json({ success: true, skipped: "not eligible" });
    }
    if (config.released_at) {
      return res.json({ success: true, skipped: "already released" });
    }

    const result = await service.release(eventId);
    void notifyRecipients(result.certificates);
    return res.json({ success: true, issued: result.issued });
  } catch (error: any) {
    console.error("[Certificate] processScheduledRelease error:", error);
    return res.status(500).json({ error: error?.message });
  }
};

/** Send "your certificate is ready" emails (best-effort). */
async function notifyRecipients(
  certificates: Array<{
    recipient_email: string | null;
    recipient_name: string | null;
    event_name: string | null;
    verify_code: string;
  }>,
) {
  for (const cert of certificates) {
    if (!cert.recipient_email) continue;
    try {
      await emailService.sendCertificateAvailableEmail({
        to: cert.recipient_email,
        name: cert.recipient_name || "there",
        eventName: cert.event_name || "the event",
        url: certUrl(cert.verify_code),
      });
    } catch (err) {
      console.error(
        "[Certificate] failed to email",
        cert.recipient_email,
        err,
      );
    }
  }
}
