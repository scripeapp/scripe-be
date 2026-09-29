import { z } from "zod";

const uuid = z.string().uuid();

const posItemSchema = z.object({
  product_id: uuid,
  variant_id: uuid.nullable().optional(),
  quantity: z.number().int().min(1).max(999).default(1),
  selected_modifiers: z
    .array(
      z.object({
        modifier_option_id: uuid,
        quantity: z.number().int().min(1).max(999).default(1),
      }),
    )
    .max(32)
    .default([]),
  note: z.string().trim().max(500).optional(),
});

/** Line-level pricing for the shopping cart on the till. */
export const posPreviewSchema = z.object({
  store_id: uuid,
  branch_id: uuid,
  items: z.array(posItemSchema).min(1).max(100),
});

export const posOrderSchema = z
  .object({
    store_id: uuid,
    branch_id: uuid,
    items: z.array(posItemSchema).min(1).max(100).optional(),
    payment_method: z.enum(["cash", "card", "bank_transfer", "online"]),
    register_shift_id: uuid.nullable().optional(),
    booking_id: uuid.nullable().optional(),
    tip: z
      .object({
        amount_minor: z.number().int().min(0),
        staff_id: uuid.nullable().optional(),
      })
      .optional(),
  })
  .refine((value) => Boolean(value.booking_id) || (value.items?.length ?? 0) > 0, {
    message: "Provide items or a booking to charge",
    path: ["items"],
  });

export const posBookingsQuerySchema = z.object({
  store_id: uuid,
});

export const posPhase = {
  preview: posPreviewSchema,
  order: posOrderSchema,
} as const;