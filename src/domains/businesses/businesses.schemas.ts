import { z } from "zod";

export const businessIdParamsSchema = z.object({ businessId: z.string().uuid() });

export const createBusinessSchema = z.object({
  displayName: z.string().trim().min(1).max(160),
  defaultCurrency: z.string().trim().regex(/^[A-Za-z]{3}$/).transform((value) => value.toUpperCase()).default("NGN"),
  timezone: z.string().trim().min(1).max(100).default("Africa/Lagos"),
  primaryVertical: z.string().trim().min(1).max(100).nullable().optional(),
});

// Address fields aren't accepted at creation — app.create_business_with_default_store
// has no columns for them, and a registered address is filled in later
// (e.g. before a business's first Brails payout), not required up front.
export const updateBusinessSchema = createBusinessSchema
  .partial()
  .extend({
    website: z
      .string()
      .trim()
      .max(2048)
      .refine(
        (value) => value === "" || /^https?:\/\//i.test(value),
        "Website must start with http:// or https://",
      )
      .optional(),
    addressLine1: z.string().trim().min(1).max(200).nullable().optional(),
    addressLine2: z.string().trim().min(1).max(200).nullable().optional(),
    city: z.string().trim().min(1).max(100).nullable().optional(),
    state: z.string().trim().min(1).max(100).nullable().optional(),
    postalCode: z.string().trim().min(1).max(20).nullable().optional(),
    country: z.string().trim().min(1).max(100).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export type CreateBusinessRequest = z.infer<typeof createBusinessSchema>;
export type UpdateBusinessRequest = z.infer<typeof updateBusinessSchema>;
