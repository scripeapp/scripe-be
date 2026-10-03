import { z } from "zod";

export const uploadParamsSchema = z.object({ uploadId: z.string().uuid() });

export const listQuerySchema = z.object({
  businessId: z.string().uuid().optional(),
  purpose: z.enum(["product_image", "compliance_document", "avatar", "business_logo", "business_cover", "other"]).optional(),
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;
const MAX_BRANDING_SIZE_BYTES = 5 * 1024 * 1024;
const BRANDING_PURPOSES: ReadonlySet<string> = new Set(["business_logo", "business_cover"]);

export const createUploadSchema = z.object({
  businessId: z.string().uuid().nullable().optional(),
  purpose: z.enum(["product_image", "compliance_document", "avatar", "business_logo", "business_cover", "other"]),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z
    .string()
    .regex(/^[1-9][0-9]*$/, "Must be a positive integer byte count")
    .refine((value) => BigInt(value) <= BigInt(MAX_SIZE_BYTES), `Upload must be ${MAX_SIZE_BYTES} bytes or smaller`),
  checksum: z.string().trim().max(128).nullable().optional(),
})
  // Branding images are shown on public pages and in emails: images only, at most 5 MB, and always owned by a business.
  .refine((value) => !BRANDING_PURPOSES.has(value.purpose) || value.mimeType !== "application/pdf", { message: "A branding image must be an image", path: ["mimeType"] })
  .refine((value) => !BRANDING_PURPOSES.has(value.purpose) || BigInt(value.sizeBytes) <= BigInt(MAX_BRANDING_SIZE_BYTES), { message: "A branding image must be 5 MB or smaller", path: ["sizeBytes"] })
  .refine((value) => !BRANDING_PURPOSES.has(value.purpose) || Boolean(value.businessId), { message: "A branding image belongs to a business", path: ["businessId"] });
