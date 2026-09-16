import { z } from "zod";

/**
 * Address Validation Schemas
 * Zod schemas for user address CRUD operations
 */

// Create address schema
export const createAddressSchema = z.object({
  label: z.string().max(50).optional(),
  recipient_name: z.string().min(1).max(255),
  phone: z.string().min(1).max(50),
  address_line_1: z.string().min(1).max(255),
  address_line_2: z.string().max(255).optional(),
  city: z.string().min(1).max(100),
  state: z.string().min(1).max(100),
  postal_code: z.string().max(20).optional(),
  country: z.string().max(100).optional().default("Nigeria"),
  is_default: z.boolean().optional().default(false),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  shipbubble_address_code: z.number().optional(),
});

// Update address schema (partial)
export const updateAddressSchema = z.object({
  label: z.string().max(50).optional(),
  recipient_name: z.string().min(1).max(255).optional(),
  phone: z.string().min(1).max(50).optional(),
  address_line_1: z.string().min(1).max(255).optional(),
  address_line_2: z.string().max(255).nullable().optional(),
  city: z.string().min(1).max(100).optional(),
  state: z.string().min(1).max(100).optional(),
  postal_code: z.string().max(20).nullable().optional(),
  country: z.string().max(100).optional(),
  is_default: z.boolean().optional(),
  latitude: z.number().nullable().optional(),
  longitude: z.number().nullable().optional(),
  shipbubble_address_code: z.number().nullable().optional(),
});

// Address ID parameter schema
export const addressIdSchema = z.object({
  id: z.string().uuid(),
});

// Types
export type CreateAddressInput = z.infer<typeof createAddressSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;

export const addressSchemas = {
  createAddress: createAddressSchema,
  updateAddress: updateAddressSchema,
  addressId: addressIdSchema,
};
