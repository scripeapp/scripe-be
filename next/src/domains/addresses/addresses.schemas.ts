import { z } from "zod";

export const addressParamsSchema = z.object({ addressId: z.string().uuid() });

const nullableTrimmed = (max: number) => z.string().trim().max(max).nullable().optional();

export const createAddressSchema = z.object({
  label: nullableTrimmed(50),
  isDefault: z.boolean().optional(),
  recipientName: z.string().trim().min(1).max(160),
  phone: z.string().trim().min(1).max(30),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: nullableTrimmed(200),
  city: z.string().trim().min(1).max(100),
  state: z.string().trim().min(1).max(100),
  postalCode: nullableTrimmed(20),
  country: z.string().trim().min(1).max(100).optional(),
});

export const updateAddressSchema = createAddressSchema
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");
