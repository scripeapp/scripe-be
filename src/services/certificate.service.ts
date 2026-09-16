import { SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import {
  PDFDocument,
  StandardFonts,
  rgb,
  PDFFont,
  PDFImage,
} from "pdf-lib";
import {
  CertificateConfig,
  EventCertificate,
  PublicCertificate,
  UpsertCertificateConfigInput,
} from "../types/certificate.schemas";
import {
  queueCertificateRelease,
  cancelCertificateRelease,
} from "../config/qstash";

interface EventCertContext {
  id: string;
  event_name: string | null;
  business_id: string | null;
  business_name: string | null;
  end_date: string | null;
  end_time: string | null;
  timezone: string | null;
}

/**
 * Certificate of Attendance service.
 *
 * Records are the source of truth; PDFs are generated on demand and streamed,
 * never stored. Construct with a request-scoped client for organizer actions,
 * or with the service-role (admin) client for public download / verification
 * and the QStash worker.
 */
export class CertificateService {
  constructor(private supabase: SupabaseClient) {}

  // ── Config ────────────────────────────────────────────────────────────

  async getConfig(eventId: string): Promise<CertificateConfig | null> {
    const { data, error } = await this.supabase
      .from("event_certificate_configs")
      .select("*")
      .eq("event_id", eventId)
      .maybeSingle();

    if (error) throw error;
    return data ? (data as CertificateConfig) : null;
  }

  async upsertConfig(
    eventId: string,
    businessId: string | null,
    input: UpsertCertificateConfigInput,
  ): Promise<CertificateConfig> {
    const { data, error } = await this.supabase
      .from("event_certificate_configs")
      .upsert(
        {
          event_id: eventId,
          business_id: businessId,
          ...input,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "event_id" },
      )
      .select()
      .single();

    if (error) throw error;
    return data as CertificateConfig;
  }

  /**
   * Reconcile the scheduled auto-release for an event based on its current
   * config. Cancels any stale job and schedules a fresh one when the config is
   * enabled, in auto mode, and not yet released. Safe to call after every save.
   */
  async syncAutoReleaseSchedule(eventId: string): Promise<void> {
    const config = await this.getConfig(eventId);
    if (!config) return;

    // Cancel any existing scheduled job first.
    if (config.release_job_id) {
      await cancelCertificateRelease(config.release_job_id);
      await this.supabase
        .from("event_certificate_configs")
        .update({ release_job_id: null })
        .eq("event_id", eventId);
    }

    const shouldSchedule =
      config.enabled &&
      config.release_mode === "auto" &&
      !config.released_at;
    if (!shouldSchedule) return;

    const ctx = await this.getEventContext(eventId);
    if (!ctx) return;

    const endAt = this.computeEventEndAt(
      ctx.end_date,
      ctx.end_time,
      ctx.timezone,
    );
    if (!endAt) return;

    const releaseAt = new Date(
      endAt.getTime() + config.release_delay_hours * 3600 * 1000,
    );

    // If the release window has already passed (e.g. a past event), do NOT
    // auto-fire on save. The organizer must release manually via "Release now".
    if (releaseAt.getTime() <= Date.now()) return;

    const jobId = await queueCertificateRelease({ eventId }, releaseAt);
    if (jobId) {
      await this.supabase
        .from("event_certificate_configs")
        .update({ release_job_id: jobId })
        .eq("event_id", eventId);
    }
  }

  // ── Entitlement seam (paid add-on wires in here later) ────────────────

  async canUseCertificates(_eventId: string): Promise<boolean> {
    // TODO: replace with paid add-on entitlement check.
    return true;
  }

  // ── Eligibility + release ─────────────────────────────────────────────

  private async getEventContext(
    eventId: string,
  ): Promise<EventCertContext | null> {
    const { data, error } = await this.supabase
      .from("events")
      .select(
        "id, event_name, business_id, end_date, end_time, timezone, business:business_id(name)",
      )
      .eq("id", eventId)
      .single();

    if (error) return null;
    const row = data as any;
    return {
      id: row.id,
      event_name: row.event_name ?? null,
      business_id: row.business_id ?? null,
      business_name: row.business?.name ?? null,
      end_date: row.end_date ?? null,
      end_time: row.end_time ?? null,
      timezone: row.timezone ?? null,
    };
  }

  /**
   * Compute the event's absolute end instant from the (end_date, end_time,
   * timezone) triple. timezone is a descriptive string like
   * "UTC+01:00 West Central Africa" — we parse the offset prefix.
   */
  computeEventEndAt(
    endDate: string | null,
    endTime: string | null,
    timezone: string | null,
  ): Date | null {
    if (!endDate) return null;
    const time = (endTime || "00:00").slice(0, 8);
    const match = (timezone || "").match(/UTC([+-])(\d{2}):?(\d{2})/i);
    const offset = match ? `${match[1]}${match[2]}:${match[3]}` : "+00:00";
    const iso = `${endDate}T${time.length === 5 ? time + ":00" : time}${offset}`;
    const date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }

  async getEligibleTickets(
    eventId: string,
    eligibility: "registered" | "checked_in",
  ): Promise<
    Array<{ id: string; customer_name: string | null; customer_email: string | null }>
  > {
    let query = this.supabase
      .from("issued_tickets")
      .select("id, customer_name, customer_email")
      .eq("event_id", eventId);

    if (eligibility === "checked_in") {
      query = query.eq("checked_in", true);
    }

    const { data, error } = await query;
    if (error) throw error;
    return (data as any[]) || [];
  }

  /**
   * Issue certificates for all eligible tickets (idempotent per ticket) and
   * mark the config released. Returns counts. Does NOT send emails — the
   * caller handles notification.
   */
  async release(
    eventId: string,
  ): Promise<{ issued: number; skipped: number; certificates: EventCertificate[] }> {
    const allowed = await this.canUseCertificates(eventId);
    if (!allowed) {
      throw new Error("Certificate add-on is not enabled for this event");
    }

    const config = await this.getConfig(eventId);
    if (!config || !config.enabled) {
      throw new Error("Certificates are not enabled for this event");
    }

    const ctx = await this.getEventContext(eventId);
    if (!ctx) throw new Error("Event not found");

    const endAt = this.computeEventEndAt(
      ctx.end_date,
      ctx.end_time,
      ctx.timezone,
    );

    const tickets = await this.getEligibleTickets(eventId, config.eligibility);

    // Tickets that already have a certificate (idempotency).
    const { data: existing } = await this.supabase
      .from("event_certificates")
      .select("ticket_id")
      .eq("event_id", eventId);
    const existingTicketIds = new Set(
      (existing as any[] | null)?.map((r) => r.ticket_id) ?? [],
    );

    const toCreate = tickets.filter((t) => !existingTicketIds.has(t.id));

    const created: EventCertificate[] = [];
    if (toCreate.length > 0) {
      const rows = toCreate.map((t, idx) => ({
        event_id: eventId,
        ticket_id: t.id,
        business_id: ctx.business_id,
        recipient_name: t.customer_name,
        recipient_email: t.customer_email,
        event_name: ctx.event_name,
        business_name: ctx.business_name,
        event_end_at: endAt ? endAt.toISOString() : null,
        serial: this.generateSerial(existingTicketIds.size + idx + 1),
        verify_code: this.generateVerifyCode(),
        status: "issued" as const,
        issued_at: new Date().toISOString(),
      }));

      const { data: inserted, error } = await this.supabase
        .from("event_certificates")
        .insert(rows)
        .select();
      if (error) throw error;
      created.push(...((inserted as EventCertificate[]) || []));
    }

    await this.supabase
      .from("event_certificate_configs")
      .update({ released_at: new Date().toISOString() })
      .eq("event_id", eventId);

    return {
      issued: created.length,
      skipped: tickets.length - toCreate.length,
      certificates: created,
    };
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  async listCertificates(eventId: string): Promise<EventCertificate[]> {
    const { data, error } = await this.supabase
      .from("event_certificates")
      .select("*")
      .eq("event_id", eventId)
      .order("issued_at", { ascending: false });
    if (error) throw error;
    return (data as EventCertificate[]) || [];
  }

  async getByVerifyCode(verifyCode: string): Promise<EventCertificate | null> {
    const { data, error } = await this.supabase
      .from("event_certificates")
      .select("*")
      .eq("verify_code", verifyCode)
      .maybeSingle();
    if (error) throw error;
    return data ? (data as EventCertificate) : null;
  }

  /** Public verification + preview shape (joins template config). */
  async getPublicByVerifyCode(
    verifyCode: string,
  ): Promise<PublicCertificate | null> {
    const cert = await this.getByVerifyCode(verifyCode);
    if (!cert) return null;

    const { data: config } = await this.supabase
      .from("event_certificate_configs")
      .select(
        "accent_color, background_url, signatory_name, signatory_title, signature_url, body_text",
      )
      .eq("event_id", cert.event_id)
      .maybeSingle();

    const c = (config as any) || {};
    return {
      recipient_name: cert.recipient_name,
      event_name: cert.event_name,
      business_name: cert.business_name,
      event_end_at: cert.event_end_at,
      serial: cert.serial,
      verify_code: cert.verify_code,
      status: cert.status,
      issued_at: cert.issued_at,
      accent_color: c.accent_color ?? null,
      background_url: c.background_url ?? null,
      signatory_name: c.signatory_name ?? null,
      signatory_title: c.signatory_title ?? null,
      signature_url: c.signature_url ?? null,
      body_text: c.body_text ?? null,
    };
  }

  async revoke(certId: string): Promise<void> {
    const { error } = await this.supabase
      .from("event_certificates")
      .update({ status: "revoked" })
      .eq("id", certId);
    if (error) throw error;
  }

  // ── PDF rendering (on demand, never stored) ───────────────────────────

  async renderPdf(verifyCode: string): Promise<Uint8Array | null> {
    const cert = await this.getPublicByVerifyCode(verifyCode);
    if (!cert || cert.status === "revoked") return null;

    const pdf = await PDFDocument.create();
    // A4 landscape (points)
    const page = pdf.addPage([842, 595]);
    const { width, height } = page.getSize();

    const accent = this.hexToRgb(cert.accent_color) ?? rgb(0.31, 0.27, 0.9);
    const ink = rgb(0.1, 0.1, 0.12);
    const muted = rgb(0.45, 0.45, 0.5);

    const serif = await pdf.embedFont(StandardFonts.TimesRoman);
    const serifBold = await pdf.embedFont(StandardFonts.TimesRomanBold);
    const sans = await pdf.embedFont(StandardFonts.Helvetica);

    // Background artwork (if any), else a simple bordered frame.
    const bg = await this.tryEmbedImage(pdf, cert.background_url);
    if (bg) {
      page.drawImage(bg, { x: 0, y: 0, width, height });
      // Frosted content panel so text stays legible over ANY background image.
      const margin = 90;
      page.drawRectangle({
        x: margin,
        y: margin,
        width: width - margin * 2,
        height: height - margin * 2,
        color: rgb(1, 1, 1),
        opacity: 0.85,
      });
      // Thin accent frame around the panel (border only, no fill)
      page.drawRectangle({
        x: margin,
        y: margin,
        width: width - margin * 2,
        height: height - margin * 2,
        borderColor: accent,
        borderWidth: 2,
      });
    } else {
      page.drawRectangle({
        x: 24,
        y: 24,
        width: width - 48,
        height: height - 48,
        borderColor: accent,
        borderWidth: 3,
      });
    }

    const center = (
      text: string,
      y: number,
      font: PDFFont,
      size: number,
      color = ink,
    ) => {
      const w = font.widthOfTextAtSize(text, size);
      page.drawText(text, { x: (width - w) / 2, y, size, font, color });
    };

    center("CERTIFICATE OF ATTENDANCE", height - 130, sans, 16, muted);
    center("This is to certify that", height - 185, serif, 16, muted);
    center(cert.recipient_name || "Attendee", height - 235, serifBold, 34, accent);

    const date = cert.event_end_at
      ? new Date(cert.event_end_at).toLocaleDateString("en-US", {
          year: "numeric",
          month: "long",
          day: "numeric",
        })
      : "";

    const body =
      (cert.body_text ||
        "attended {event} on {date}.")
        .replace(/\{name\}/g, cert.recipient_name || "")
        .replace(/\{event\}/g, cert.event_name || "the event")
        .replace(/\{date\}/g, date);

    this.drawWrapped(page, body, serif, 16, ink, width, height - 285, 64);

    // Signatory block
    if (cert.signatory_name) {
      const sig = await this.tryEmbedImage(pdf, cert.signature_url);
      const baseY = 120;
      if (sig) {
        const sw = 120;
        const sh = (sig.height / sig.width) * sw;
        page.drawImage(sig, {
          x: width / 2 - sw / 2,
          y: baseY + 10,
          width: sw,
          height: Math.min(sh, 50),
        });
      }
      center(cert.signatory_name, baseY - 6, serifBold, 14, ink);
      if (cert.signatory_title) {
        center(cert.signatory_title, baseY - 24, sans, 11, muted);
      }
    }

    // Footer: business + verification
    if (cert.business_name) {
      center(`Issued by ${cert.business_name}`, 70, sans, 11, muted);
    }
    const verifyLine = `Verify: ${this.appUrl()}/event-certificates/${cert.verify_code}`;
    center(verifyLine, 52, sans, 9, muted);
    if (cert.serial) {
      page.drawText(cert.serial, {
        x: 40,
        y: 40,
        size: 9,
        font: sans,
        color: muted,
      });
    }

    return pdf.save();
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  private generateVerifyCode(): string {
    // 8 url-safe chars, grouped for readability: e.g. "A1B2-C3D4"
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const bytes = crypto.randomBytes(8);
    let out = "";
    for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
    return `${out.slice(0, 4)}-${out.slice(4)}`;
  }

  private generateSerial(n: number): string {
    const year = new Date().getFullYear();
    return `HQ-${year}-${String(n).padStart(5, "0")}`;
  }

  private hexToRgb(hex: string | null) {
    if (!hex) return null;
    const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
    if (!m) return null;
    const int = parseInt(m[1], 16);
    return rgb(((int >> 16) & 255) / 255, ((int >> 8) & 255) / 255, (int & 255) / 255);
  }

  private appUrl(): string {
    return (process.env.FRONTEND_URL || process.env.WEB_URL || "https://hilaq.com").replace(
      /\/+$/,
      "",
    );
  }

  private async tryEmbedImage(
    pdf: PDFDocument,
    url: string | null,
  ): Promise<PDFImage | null> {
    if (!url) return null;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      const type = res.headers.get("content-type") || "";
      if (type.includes("png") || url.toLowerCase().endsWith(".png")) {
        return await pdf.embedPng(buf);
      }
      return await pdf.embedJpg(buf);
    } catch {
      return null;
    }
  }

  private drawWrapped(
    page: any,
    text: string,
    font: PDFFont,
    size: number,
    color: any,
    width: number,
    startY: number,
    maxCharsPerLine: number,
  ) {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (candidate.length > maxCharsPerLine) {
        if (line) lines.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    if (line) lines.push(line);

    let y = startY;
    for (const l of lines) {
      const w = font.widthOfTextAtSize(l, size);
      page.drawText(l, { x: (width - w) / 2, y, size, font, color });
      y -= size * 1.5;
    }
  }
}

export default CertificateService;
