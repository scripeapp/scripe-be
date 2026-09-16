// ============================================================================
// Channel Marketing — TypeScript Types
// WhatsApp & SMS channels for Hilaq CRM
// ============================================================================

export type ChannelType = "whatsapp" | "sms";

// ── Message ──────────────────────────────────────────────────────────────────

export type MessageStatus =
  | "draft"
  | "preparing"
  | "scheduled"
  | "queued"
  | "processing"
  | "sent"
  | "partial"
  | "failed";

export interface ChannelMessage {
  id: string;
  business_id: string;
  channel: ChannelType;
  name: string;
  status: MessageStatus;
  segment_id: string | null;
  template_id: string | null;
  body_override: string | null;
  scheduled_at: string | null;
  sent_at: string | null;
  recipient_count: number | null;
  suppressed_count: number;
  accepted_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  clicked_count: number;
  optout_count: number;
  failed_count: number;
  credits_reserved: number;
  credits_refunded: number;
  message_parts: number;
  provider: string | null;
  queue_message_id: string | null;
  send_attempt_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  segment?: { id: string; name: string };
  template?: ChannelTemplate;
  stats?: ChannelMessageStat;
}

export interface CreateMessageBody {
  name: string;
  segment_id?: string | null;
  template_id?: string | null;
  body_override?: string;
  scheduled_at?: string | null;
}

export interface SendMessageBody {
  scheduled_at?: string | null;
}

// Aggregate counters are stored on ChannelMessage. This type is retained for
// the API response shape consumed by the existing channel UI.

export interface ChannelMessageStat {
  id: string;
  message_id: string;
  delivered_count: number;
  read_count: number | null;
  replied_count: number | null;
  clicked_count: number | null;
  optout_count: number;
  failed_count: number;
  accepted_count: number;
  updated_at: string;
}

// ── Template ─────────────────────────────────────────────────────────────────

export type TemplateCategory =
  | "marketing"
  | "utility"
  | "authentication"
  | "internal";

export type TemplateHeaderType = "none" | "text" | "image" | "document";

export type TemplateStatus =
  | "draft"
  | "pending"
  | "approved"
  | "rejected"
  | "internal";

export interface TemplateButton {
  type: "quick_reply" | "url" | "phone";
  label: string;
  value?: string;
}

export interface ChannelTemplate {
  id: string;
  business_id: string;
  channel: ChannelType;
  name: string;
  category: TemplateCategory;
  header_type: TemplateHeaderType;
  header_content: string | null;
  body: string;
  footer: string | null;
  buttons: TemplateButton[];
  wa_template_id: string | null;
  status: TemplateStatus;
  rejection_reason: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateTemplateBody {
  name: string;
  category: TemplateCategory;
  header_type?: TemplateHeaderType;
  header_content?: string;
  body: string;
  footer?: string;
  buttons?: TemplateButton[];
}
