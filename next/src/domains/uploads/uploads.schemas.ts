import { z } from "zod";

export const uploadParamsSchema = z.object({ uploadId: z.string().uuid() });

export const listQuerySchema = z.object({
  businessId: z.string().uuid().optional(),
  purpose: z.enum(["product_image", "compliance_document", "avatar", "other"]).optional(),
});

const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"] as const;
const MAX_SIZE_BYTES = 25 * 1024 * 1024;

export const createUploadSchema = z.object({
  businessId: z.string().uuid().nullable().optional(),
  purpose: z.enum(["product_image", "compliance_document", "avatar", "other"]),
  mimeType: z.enum(ALLOWED_MIME_TYPES),
  sizeBytes: z
    .string()
    .regex(/^[1-9][0-9]*$/, "Must be a positive integer byte count")
    .refine((value) => BigInt(value) <= BigInt(MAX_SIZE_BYTES), `Upload must be ${MAX_SIZE_BYTES} bytes or smaller`),
  checksum: z.string().trim().max(128).nullable().optional(),
});
