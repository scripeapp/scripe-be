import { z } from "zod";
import { ContactSchema, SegmentSchema, CampaignSchema } from "./crm";

const segmentConditionSchema = z.object({
  id: z.string().uuid().optional(),
  field: z.string().optional().default(""),
  operator: z.string().optional().default(""),
  value: z.any(),
});

const segmentGroupSchema: z.ZodSchema<any> = z.lazy(() =>
  z.object({
    id: z.string().uuid().optional(),
    logic: z.enum(["AND", "OR"]).default("AND"),
    conditions: z.array(segmentConditionSchema).default([]),
    groups: z.array(segmentGroupSchema).default([]),
  }),
);

/**
 * Comprehensive Zod schemas for all CRM API endpoints
 * Used as validation middleware at route level
 */
export const crmSchemas = {
  // ============================================================================
  // Contacts
  // ============================================================================

  getContacts: z.object({
    business_id: z.string().uuid("Business ID is required"),
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("50"),
    search: z.string().optional(),
    status: z
      .enum(["marketing", "transactional", "unsubscribed", "blocked"])
      .optional(),
    source: z
      .enum(["manual", "store", "event", "publication", "all"])
      .optional(),
  }),

  createContact: z.object({
    email: z.string().email("Invalid email address"),
    name: z.string().min(1, "Name is required").max(255),
    phone: z.string().max(50).optional(),
    status: z
      .enum(["marketing", "transactional", "unsubscribed", "blocked"])
      .default("marketing"),
    segment_ids: z.array(z.string().uuid()).optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }),

  updateContact: z.object({
    name: z.string().min(1).max(255).optional(),
    phone: z.string().max(50).nullable().optional(),
    status: z
      .enum(["marketing", "transactional", "unsubscribed", "blocked"])
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }),

  contactIdParam: z.object({
    id: z.string().uuid("Invalid contact ID"),
  }),

  bulkContacts: z.object({
    action: z.enum(["delete", "update_status"]),
    contact_ids: z
      .array(z.string().min(1))
      .min(1, "At least one contact ID required"),
    status: z
      .enum(["marketing", "transactional", "unsubscribed", "blocked"])
      .optional(),
  }),

  // Import contacts from CSV (bulk upload)
  importContacts: z.object({
    business_id: z.string().uuid("Business ID is required"),
    contacts: z
      .array(
        z.object({
          name: z.string().min(1, "Name is required").max(255),
          email: z.string().email("Invalid email address"),
          phone: z.string().max(50).optional().nullable(),
          status: z
            .enum(["marketing", "transactional", "unsubscribed", "blocked"])
            .optional(),
        }),
      )
      .min(1, "At least one contact required")
      .max(500, "Maximum 500 contacts per request"),
    options: z
      .object({
        skip_duplicates: z.boolean().default(true),
        update_existing: z.boolean().default(false),
      })
      .optional()
      .default({ skip_duplicates: true, update_existing: false }),
  }),

  // ============================================================================
  // Segments
  // ============================================================================

  // Condition schema for validation
  segmentCondition: segmentConditionSchema,

  // Recursive group schema
  segmentGroup: segmentGroupSchema,

  createSegment: z.object({
    name: z.string().min(1, "Segment name is required").max(255),
    description: z.string().nullable().optional(),
    type: z.enum(["dynamic", "static"]).default("static"),
    track_membership_changes: z.boolean().default(false),
    logic: z.enum(["AND", "OR"]).default("AND"),
    groups: z.array(segmentGroupSchema).default([]),
    filters: z.record(z.string(), z.any()).optional(),
  }),

  updateSegment: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    type: z.enum(["dynamic", "static"]).optional(),
    track_membership_changes: z.boolean().optional(),
    logic: z.enum(["AND", "OR"]).optional(),
    groups: z.array(segmentGroupSchema).optional(),
    filters: z.record(z.string(), z.any()).optional(),
  }),

  previewSegment: z.object({
    logic: z.enum(["AND", "OR"]).default("AND"),
    groups: z.array(segmentGroupSchema).min(1, "At least one group is required"),
  }),

  segmentIdParam: z.object({
    id: z.string().uuid("Invalid segment ID"),
  }),

  getSegmentContacts: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("50"),
    search: z.string().optional(),
  }),

  segmentContacts: z.object({
    contact_ids: z
      .array(z.string().min(1))
      .min(1, "At least one contact ID required"),
  }),

  // ============================================================================
  // Campaigns
  // ============================================================================

  getCampaigns: z.object({
    business_id: z.string().uuid("Business ID is required"),
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("20"),
    status: z
      .enum([
        "draft",
        "scheduled",
        "sending",
        "sent",
        "paused",
        "failed",
        "cancelled",
      ])
      .optional(),
  }),

  getCampaignRecipients: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("20"),
    status: z
      .enum([
        "sent",
        "delivered",
        "opened",
        "clicked",
        "bounced",
        "unsubscribed",
      ])
      .optional(),
  }),

  createCampaign: z.object({
    name: z.string().min(1, "Campaign name is required").max(255),
    description: z.string().nullable().optional(),
    type: z.enum(["broadcast", "automated"]).default("broadcast"),
    audience_type: z.enum(["all_contacts", "segment", "manual"]),
    audience_ref: z.any().optional(), // segment_id or contact_ids array
    subject: z.string().min(1, "Subject is required").max(255),
    from_name: z.string().min(1).max(100).default("Hilaq"),
    from_email: z.string().email().optional(),
    content: z.object({
      html: z.string(),
      text: z.string().optional(),
    }),
    send_type: z.enum(["immediate", "scheduled"]).default("immediate"),
    scheduled_at: z.string().datetime().nullable().optional(),
  }),

  updateCampaign: z.object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    audience_type: z.enum(["all_contacts", "segment", "manual"]).optional(),
    audience_ref: z.any().optional(),
    subject: z.string().min(1).max(255).optional(),
    from_name: z.string().min(1).max(100).optional(),
    from_email: z.string().email().optional(),
    content: z
      .object({
        html: z.string(),
        text: z.string().optional(),
      })
      .optional(),
    send_type: z.enum(["immediate", "scheduled"]).optional(),
    scheduled_at: z.string().datetime().nullable().optional(),
  }),

  campaignIdParam: z.object({
    id: z.string().uuid("Invalid campaign ID"),
  }),

  validateAudience: z.object({
    audience_type: z.enum(["all_contacts", "segment", "manual"]),
    audience_ref: z.any().optional(),
  }),

  initializeCampaignCreditTopUp: z.object({
    business_id: z.string().uuid("Business ID is required"),
    package_id: z.string().min(1, "Package is required"),
    callback_url: z.string().url().optional(),
  }),

  scheduleCampaign: z.object({
    scheduled_at: z.string().datetime("Invalid datetime format"),
  }),
};
