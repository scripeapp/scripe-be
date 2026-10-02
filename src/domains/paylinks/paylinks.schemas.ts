import { z } from "zod";

const minorAmount = z.union([z.number().int().positive().max(100_000_000_000), z.string().regex(/^[1-9]\d{0,11}$/)]);

/** https only: the URL is opened after payment, so javascript:, data: and plain-http URLs are refused. */
const redirectUrl = z
  .string()
  .trim()
  .url()
  .max(500)
  .refine((value) => value.toLowerCase().startsWith("https://"), "Redirect URL must start with https://");

export const businessParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const paylinkParamsSchema = z.object({
  businessId: z.string().uuid(),
  paylinkId: z.string().uuid(),
});

export const publicPaylinkParamsSchema = z.object({
  slug: z.string().trim().min(3).max(60),
});

export const publicStatusParamsSchema = z.object({
  reference: z.string().trim().min(3).max(120),
});

export const listPaylinksQuerySchema = z.object({
  status: z.enum(["active", "paused", "archived", "all"]).default("all"),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const createPaylinkSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
  mode: z.enum(["take_payment", "product", "donation"]),
  description: z.string().trim().max(1000).optional().nullable(),
  imageKey: z.string().trim().max(255).optional().nullable(),
  amountType: z.enum(["fixed", "customer_sets"]).default("fixed"),
  amountMinor: minorAmount.optional().nullable(),
  minAmountMinor: minorAmount.optional().nullable(),
  suggestedAmountsMinor: z.array(minorAmount).max(8).optional().default([]),
  currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
  productVariantId: z.string().uuid().optional().nullable(),
  customSlug: z.string().trim().regex(/^[a-z0-9-]{3,60}$/, "Slug must be 3-60 lowercase characters, numbers or hyphens").optional().nullable(),
  collectName: z.boolean().default(true),
  collectPhone: z.boolean().default(true),
  collectAddress: z.boolean().default(false),
  redirectUrl: redirectUrl.optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  storeId: z.string().uuid().optional().nullable(),
  status: z.enum(["active", "paused"]).default("active"),
}).superRefine((value, ctx) => {
  if (value.mode === "product" && !value.productVariantId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["productVariantId"], message: "Choose a product for a product link" });
  }
  if (value.amountType === "fixed" && value.mode !== "product" && !value.amountMinor) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["amountMinor"], message: "A fixed-amount link needs an amount" });
  }
});

export const updatePaylinkSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional().nullable(),
  imageKey: z.string().trim().max(255).optional().nullable(),
  amountType: z.enum(["fixed", "customer_sets"]).optional(),
  amountMinor: minorAmount.optional().nullable(),
  minAmountMinor: minorAmount.optional().nullable(),
  suggestedAmountsMinor: z.array(minorAmount).max(8).optional(),
  collectName: z.boolean().optional(),
  collectPhone: z.boolean().optional(),
  collectAddress: z.boolean().optional(),
  redirectUrl: redirectUrl.optional().nullable(),
  expiresAt: z.string().datetime().optional().nullable(),
  status: z.enum(["active", "paused"]).optional(),
});

export const publicCheckoutSchema = z.object({
  customerName: z.string().trim().min(1, "Name is required").max(120),
  customerEmail: z.string().trim().email("Valid email is required").max(255),
  customerPhone: z.string().trim().min(7).max(30).optional().nullable(),
  amountMinor: minorAmount.optional().nullable(),
  quantity: z.number().int().positive().max(100).default(1),
  deliveryAddress: z
    .object({
      streetAddress: z.string().trim().max(255).optional(),
      city: z.string().trim().max(100).optional(),
      state: z.string().trim().max(100).optional(),
    })
    .optional()
    .nullable(),
  idempotencyKey: z.string().trim().min(4).max(120).optional().nullable(),
});
