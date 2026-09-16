import { z } from "zod";

const optionalUuid = z.string().uuid().optional();
const businessContext = { business_id: z.string().uuid().optional() };

export const channelSchemas = {
  createMessage: z.object({
    ...businessContext,
    name: z.string().trim().min(1).max(255),
    segment_id: optionalUuid.nullable(),
    template_id: optionalUuid.nullable(),
    body_override: z.string().trim().min(1).max(5000).optional(),
    scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  }),
  updateMessage: z
    .object({
      ...businessContext,
      name: z.string().trim().min(1).max(255).optional(),
      segment_id: optionalUuid.nullable(),
      template_id: optionalUuid.nullable(),
      body_override: z.string().trim().min(1).max(5000).optional(),
      scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
    })
    .refine((value) => Object.keys(value).length > 0, "At least one field is required"),
  sendMessage: z.object({
    ...businessContext,
    scheduled_at: z.string().datetime({ offset: true }).nullable().optional(),
  }),
  estimateMessage: z.object({
    ...businessContext,
    segment_id: optionalUuid.nullable(),
    body: z.string().trim().min(1).max(5000),
  }),
};
