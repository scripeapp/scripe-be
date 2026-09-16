import { z } from "zod";

/**
 * Schemas + inferred types for the event Certificate of Attendance feature.
 */

export const upsertCertificateConfigSchema = z.object({
  enabled: z.boolean().optional(),
  eligibility: z.enum(["registered", "checked_in"]).optional(),
  release_mode: z.enum(["auto", "manual"]).optional(),
  release_delay_hours: z.number().int().min(0).max(24).optional(),
  background_url: z.string().url().nullable().optional(),
  accent_color: z.string().nullable().optional(),
  signatory_name: z.string().nullable().optional(),
  signatory_title: z.string().nullable().optional(),
  signature_url: z.string().url().nullable().optional(),
  body_text: z.string().nullable().optional(),
});

export type UpsertCertificateConfigInput = z.infer<
  typeof upsertCertificateConfigSchema
>;

export interface CertificateConfig {
  id: string;
  event_id: string;
  business_id: string | null;
  enabled: boolean;
  eligibility: "registered" | "checked_in";
  release_mode: "auto" | "manual";
  release_delay_hours: number;
  released_at: string | null;
  release_job_id: string | null;
  background_url: string | null;
  accent_color: string | null;
  signatory_name: string | null;
  signatory_title: string | null;
  signature_url: string | null;
  body_text: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventCertificate {
  id: string;
  event_id: string;
  ticket_id: string;
  business_id: string | null;
  recipient_name: string | null;
  recipient_email: string | null;
  event_name: string | null;
  business_name: string | null;
  event_end_at: string | null;
  serial: string | null;
  verify_code: string;
  status: "issued" | "revoked";
  issued_at: string;
  created_at: string;
}

/** Public-safe shape returned by the verification endpoint. */
export interface PublicCertificate {
  recipient_name: string | null;
  event_name: string | null;
  business_name: string | null;
  event_end_at: string | null;
  serial: string | null;
  verify_code: string;
  status: "issued" | "revoked";
  issued_at: string;
  // Template bits needed to render the preview (no sensitive data)
  accent_color: string | null;
  background_url: string | null;
  signatory_name: string | null;
  signatory_title: string | null;
  signature_url: string | null;
  body_text: string | null;
}
