import { z } from "zod";

// ============================================================================
// Communications Types (Domains & Senders)
// ============================================================================

// DNS Record Schema
export const DnsRecordSchema = z.object({
  type: z.enum(["TXT", "CNAME", "MX"]),
  name: z.string(),
  value: z.string(),
  verified: z.boolean().default(false),
});

// Domain Schema
export const CommunicationDomainSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  domain: z.string().min(1).max(255),
  status: z.enum(["pending", "verified", "failed", "needs_attention"]).default("pending"),
  dns_records: z.array(DnsRecordSchema).default([]),
  verified_at: z.string().datetime().nullable().optional(),
  last_verified_at: z.string().datetime().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Sender Schema
export const CommunicationSenderSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  domain_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(100),
  email: z.string().email().max(255),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
  used_by: z.array(z.string()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// ============================================================================
// TypeScript Types
// ============================================================================

export type DnsRecord = z.infer<typeof DnsRecordSchema>;
export type CommunicationDomain = z.infer<typeof CommunicationDomainSchema>;
export type CommunicationSender = z.infer<typeof CommunicationSenderSchema>;

// Default Hilaq sender fallback
export const HILAQ_DEFAULT_SENDER: Pick<CommunicationSender, "name" | "email"> = {
  name: "Hilaq",
  email: "noreply@hilaq.com",
};
