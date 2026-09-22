import { z } from "zod";

export const notificationParamsSchema = z.object({ notificationId: z.string().uuid() });

export const preferenceParamsSchema = z.object({
  type: z.string().trim().min(1).max(100),
  channel: z.enum(["email", "sms", "push", "in_app"]),
});

export const listQuerySchema = z.object({
  unreadOnly: z.coerce.boolean().optional(),
  includeArchived: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const updateNotificationSchema = z
  .object({
    read: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => value.read !== undefined || value.archived !== undefined, "At least one of read or archived is required");

export const setPreferenceSchema = z.object({
  enabled: z.boolean(),
});
