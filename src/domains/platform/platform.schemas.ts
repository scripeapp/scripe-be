import { z } from "zod";
import { PLATFORM_ADMINISTRATOR_ROLES } from "./platform.types.js";

const roleSchema = z.enum(PLATFORM_ADMINISTRATOR_ROLES);
const severitySchema = z.enum(["critical", "high", "medium", "low", "info"]);
const announcementTypeSchema = z.enum(["info", "warning", "feature", "maintenance", "changelog"]);
const audienceSchema = z.enum(["all", "pro", "plus", "starter", "paid"]);

export const administratorParamsSchema = z.object({ administratorId: z.string().uuid() });

export const createAdministratorSchema = z.object({
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(200),
  role: roleSchema,
  permissions: z.array(z.string().trim().min(1)).optional(),
});

export const updateAdministratorSchema = z
  .object({
    role: roleSchema.optional(),
    isActive: z.boolean().optional(),
    permissions: z.array(z.string().trim().min(1)).optional(),
  })
  .refine((value) => value.role !== undefined || value.isActive !== undefined || value.permissions !== undefined, "At least one field is required");

export const listAlertsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  unreadOnly: z.coerce.boolean().optional(),
  severity: severitySchema.optional(),
  type: z.string().trim().min(1).max(100).optional(),
});

export const markAlertsReadSchema = z.object({
  alertIds: z.array(z.string().uuid()).optional(),
});

export const announcementParamsSchema = z.object({ announcementId: z.string().uuid() });

export const listAnnouncementsQuerySchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  activeOnly: z.coerce.boolean().optional(),
});

const ctaFieldsSchema = z
  .object({
    ctaLabel: z.string().trim().min(1).max(80).nullish(),
    ctaUrl: z.string().trim().url().max(2048).nullish(),
  })
  .refine((value) => (value.ctaLabel == null) === (value.ctaUrl == null), "ctaLabel and ctaUrl must be provided together");

export const createAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(5000),
    type: announcementTypeSchema,
    audience: audienceSchema,
    isActive: z.boolean().optional(),
    startsAt: z.string().datetime().nullish(),
    endsAt: z.string().datetime().nullish(),
  })
  .and(ctaFieldsSchema);

export const updateAnnouncementSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    body: z.string().trim().min(1).max(5000).optional(),
    type: announcementTypeSchema.optional(),
    audience: audienceSchema.optional(),
    isActive: z.boolean().optional(),
    startsAt: z.string().datetime().nullish(),
    endsAt: z.string().datetime().nullish(),
    ctaLabel: z.string().trim().min(1).max(80).nullish(),
    ctaUrl: z.string().trim().url().max(2048).nullish(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    "At least one field is required",
  );
