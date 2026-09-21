import { z } from "zod";

const channelSchema = z.enum(["email", "sms", "whatsapp"]);
const audienceTypeSchema = z.enum(["all", "segment"]);

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

// Domains
export const domainParamsSchema = businessParamsSchema.extend({ domainId: z.string().uuid() });
export const addDomainSchema = z.object({
  domain: z.string().trim().min(1).max(255).regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9]?(\.[a-zA-Z]{2,})+$/, "Invalid domain format"),
});

// Senders
export const senderParamsSchema = businessParamsSchema.extend({ senderId: z.string().uuid() });
export const createSenderSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(255),
  domainId: z.string().uuid().optional(),
});
export const updateSenderSchema = z
  .object({ name: z.string().trim().min(1).max(100).optional(), isActive: z.boolean().optional() })
  .refine((value) => value.name !== undefined || value.isActive !== undefined, "At least one field is required");

// Templates
export const templateParamsSchema = businessParamsSchema.extend({ templateId: z.string().uuid() });
export const listTemplatesQuerySchema = z.object({ channel: channelSchema.optional() });
export const createTemplateSchema = z
  .object({
    channel: channelSchema,
    name: z.string().trim().min(1).max(150),
    subject: z.string().trim().min(1).max(250).optional(),
    body: z.string().trim().min(1).max(20000),
  })
  .refine((value) => (value.channel === "email") === (value.subject !== undefined), "subject is required for email templates and not allowed for sms/whatsapp");
export const updateTemplateSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    subject: z.string().trim().min(1).max(250).nullish(),
    body: z.string().trim().min(1).max(20000).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");

// Audience segments
export const segmentParamsSchema = businessParamsSchema.extend({ segmentId: z.string().uuid() });
export const segmentMemberParamsSchema = segmentParamsSchema.extend({ partyId: z.string().uuid() });
export const createSegmentSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(1000).optional(),
});
export const updateSegmentSchema = z
  .object({ name: z.string().trim().min(1).max(150).optional(), description: z.string().trim().max(1000).nullish() })
  .refine((value) => value.name !== undefined || value.description !== undefined, "At least one field is required");
export const addSegmentMembersSchema = z.object({ partyIds: z.array(z.string().uuid()).min(1).max(500) });

// Opt-outs
export const optOutSchema = z.object({
  partyId: z.string().uuid(),
  channel: channelSchema,
  reason: z.string().trim().max(500).optional(),
});
export const optInSchema = z.object({ partyId: z.string().uuid(), channel: channelSchema });

// Credits
export const initiateTopupSchema = z.object({
  packageId: z.string().trim().min(1),
  gateway: z.enum(["paystack", "flutterwave"]),
  callbackUrl: z.string().url().optional(),
});

// Messages
export const messageParamsSchema = businessParamsSchema.extend({ messageId: z.string().uuid() });
export const listMessagesQuerySchema = z.object({
  channel: channelSchema.optional(),
  status: z.enum(["draft", "processing", "sent", "partial", "failed", "cancelled"]).optional(),
});
const audienceFieldsSchema = z
  .object({ audienceType: audienceTypeSchema, audienceSegmentId: z.string().uuid().optional() })
  .refine((value) => (value.audienceType === "segment") === (value.audienceSegmentId !== undefined), "audienceSegmentId is required when audienceType is segment");

export const createMessageSchema = z
  .object({
    channel: channelSchema,
    name: z.string().trim().min(1).max(150),
    templateId: z.string().uuid().optional(),
    senderId: z.string().uuid().optional(),
    subject: z.string().trim().min(1).max(250).optional(),
    body: z.string().trim().min(1).max(20000).optional(),
  })
  .and(audienceFieldsSchema)
  .refine((value) => value.templateId !== undefined || value.body !== undefined, "Either templateId or body is required");

export const updateMessageSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    templateId: z.string().uuid().nullish(),
    senderId: z.string().uuid().nullish(),
    subject: z.string().trim().min(1).max(250).nullish(),
    body: z.string().trim().min(1).max(20000).nullish(),
    audienceType: audienceTypeSchema.optional(),
    audienceSegmentId: z.string().uuid().nullish(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");

export const estimateCostSchema = z.object({ channel: channelSchema, body: z.string().trim().min(1).max(20000) }).and(audienceFieldsSchema);
