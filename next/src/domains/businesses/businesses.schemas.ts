import { z } from "zod";

export const businessIdParamsSchema = z.object({ businessId: z.string().uuid() });

export const createBusinessSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  defaultCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()).default("NGN"),
  timezone: z.string().trim().min(1).max(100).default("Africa/Lagos"),
  primaryVertical: z.string().trim().min(1).max(100).nullable().optional(),
});

export const updateBusinessSchema = createBusinessSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  "At least one field is required",
);

export type CreateBusinessRequest = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessRequest = z.infer<typeof updateBusinessSchema>;
