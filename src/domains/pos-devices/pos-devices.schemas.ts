import { z } from "zod";

const uuid = z.string().uuid();
const moneyMinor = z.coerce.number().int().min(0);

export const registerParamsSchema = z.object({ businessId: uuid, storeId: uuid, registerId: uuid });

export const pairSchema = z.object({
  pairing_code: z.string().transform((value) => value.replace(/\D/g, "")).pipe(z.string().length(16, "Enter the 16-digit code")),
  label: z.string().trim().max(100).optional(),
  platform: z.enum(["web", "android", "ios", "pos_terminal"]).optional(),
});

export const unlockSchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "Enter your 4-digit PIN"),
  expected_staff_id: uuid.optional(),
});

const tillItemSchema = z.object({
  product_id: uuid,
  variant_id: uuid.nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_modifiers: z.array(z.object({ modifier_option_id: uuid, quantity: z.number().int().min(1).max(999).default(1) })).max(32).default([]),
});

export const previewSchema = z.object({ items: z.array(tillItemSchema).min(1).max(100) });

export const chargeSchema = z.object({
  items: z.array(tillItemSchema).min(1).max(100),
  payment_method: z.enum(["cash", "card", "bank_transfer"]),
  staff_id: uuid,
  idempotency_key: z.string().trim().min(8).max(100),
  customer_id: uuid.nullable().optional(),
});

export const openShiftSchema = z.object({ opening_cash_minor: moneyMinor.default(0), staff_id: uuid });
export const closeShiftSchema = z.object({ counted_cash_minor: moneyMinor, staff_id: uuid, notes: z.string().trim().max(1000).optional() });

export const ordersQuerySchema = z.object({
  status: z.enum(["all", "open", "fulfilled"]).default("all"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const customersQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const productParamsSchema = z.object({ productId: uuid });
