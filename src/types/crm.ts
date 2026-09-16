import { z } from "zod";

// ============================================================================
// Enums
// ============================================================================

export const ContactStatus = {
  MARKETING: "marketing",
  TRANSACTIONAL: "transactional",
  UNSUBSCRIBED: "unsubscribed",
  BLOCKED: "blocked",
} as const;

export const CampaignStatus = {
  DRAFT: "draft",
  SCHEDULED: "scheduled",
  SENT: "sent",
  CANCELLED: "cancelled",
} as const;

// ============================================================================
// Zod Schemas
// ============================================================================

// Contact Schema
export const ContactSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().min(1).max(255),
  phone: z.string().max(50).nullable().optional(),
  status: z.enum(["marketing", "transactional", "unsubscribed", "blocked"]).default("marketing"),
  metadata: z.record(z.string(), z.any()).default({}),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Segment Condition Schema
export const SegmentConditionSchema = z.object({
  id: z.string().uuid(),
  field: z.string().min(1),
  operator: z.string().min(1),
  value: z.any(),
});

// Segment Group Schema (recursive)
export const SegmentGroupSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    id: z.string().uuid(),
    logic: z.enum(["AND", "OR"]).default("AND"),
    conditions: z.array(SegmentConditionSchema).default([]),
    groups: z.array(SegmentGroupSchema).default([]),
  })
);

// Segment Schema (enhanced for dynamic segments)
export const SegmentSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  type: z.enum(["dynamic", "static"]).default("static"),
  track_membership_changes: z.boolean().default(false),
  logic: z.enum(["AND", "OR"]).default("AND"),
  groups: z.array(SegmentGroupSchema).default([]),
  filters: z.record(z.string(), z.any()).default({}), // Legacy field
  contact_count: z.number().int().default(0),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Campaign Metrics Schema
export const CampaignMetricsSchema = z.object({
  sent: z.number().int().default(0),
  delivered: z.number().int().default(0),
  opens: z.number().int().default(0),
  clicks: z.number().int().default(0),
  bounces: z.number().int().default(0),
  unsubscribes: z.number().int().default(0),
});

// Campaign Content Schema
export const CampaignContentSchema = z.object({
  html: z.string().default(""),
  text: z.string().default(""),
});

// Campaign Schema (enhanced)
export const CampaignSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string().nullable().optional(),
  type: z.enum(["broadcast", "automated"]).default("broadcast"),
  status: z.enum(["draft", "scheduled", "sending", "sent", "paused", "failed", "cancelled"]).default("draft"),
  audience_type: z.enum(["all_contacts", "segment", "manual"]),
  audience_ref: z.any().nullable().optional(), // segment_id (string) or contact_ids (string[])
  audience_count: z.number().int().default(0),
  excluded_count: z.number().int().default(0),
  subject: z.string().min(1).max(255),
  from_name: z.string().min(1).max(100).default("Hilaq"),
  from_email: z.string().email().default("noreply@hilaq.com"),
  content: CampaignContentSchema.default({ html: "", text: "" }),
  send_type: z.enum(["immediate", "scheduled"]).default("immediate"),
  scheduled_at: z.string().datetime().nullable().optional(),
  sent_at: z.string().datetime().nullable().optional(),
  metrics: CampaignMetricsSchema.default({
    sent: 0,
    delivered: 0,
    opens: 0,
    clicks: 0,
    bounces: 0,
    unsubscribes: 0,
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Legacy alias
export const CampaignStatsSchema = CampaignMetricsSchema;

// ============================================================================
// TypeScript Types (inferred from Zod schemas)
// ============================================================================

export type Contact = z.infer<typeof ContactSchema>;
export type SegmentCondition = z.infer<typeof SegmentConditionSchema>;
export type SegmentGroup = z.infer<typeof SegmentGroupSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type CampaignMetrics = z.infer<typeof CampaignMetricsSchema>;
export type CampaignContent = z.infer<typeof CampaignContentSchema>;
export type CampaignStats = z.infer<typeof CampaignStatsSchema>;
export type Campaign = z.infer<typeof CampaignSchema>;

// Segment with contact count (for list response)
export type SegmentWithCount = Segment & {
  contact_count: number;
};

