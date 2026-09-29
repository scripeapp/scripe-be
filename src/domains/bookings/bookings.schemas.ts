import { z } from "zod";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const phone = z
  .string()
  .trim()
  .min(7)
  .max(20)
  .regex(/^\+?[0-9]{7,20}$/)
  .optional();

export const reserveBookingSchema = z.object({
  store_id: uuid,
  product_id: uuid,
  variant_id: uuid.nullable().optional(),
  staff_id: uuid,
  location_id: uuid.nullable().optional(),
  // ISO instant in the store's timezone; the engine truncates to the minute and
  // the SECURITY DEFINER function re-derives ends_at from server data.
  starts_at: isoDateTime,
  manage_token: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  hold_minutes: z.number().int().min(1).max(60).optional(),
  customer: z
    .object({
      name: z.string().trim().min(1).max(160).nullable().optional(),
      email: z.string().trim().email().max(320).nullable().optional(),
      phone,
    })
    .optional(),
});

export const createBookingSchema = z.object({
  store_id: uuid,
  location_id: uuid.nullable().optional(),
  starts_at: isoDateTime,
  source: z.enum(["dashboard", "walk_in", "pos"]).default("dashboard"),
  notes: z.string().trim().max(1000).nullable().optional(),
  customer: z
    .object({
      name: z.string().trim().max(160).nullable().optional(),
      email: z.string().trim().email().max(320).nullable().optional().or(z.literal("")),
      phone: z.string().trim().max(20).nullable().optional(),
    })
    .optional(),
  // Services in the visit, performed back to back in this order.
  items: z
    .array(
      z.object({
        product_id: uuid,
        variant_id: uuid.nullable().optional(),
        staff_id: uuid,
        modifier_option_ids: z.array(uuid).max(20).default([]),
      }),
    )
    .min(1)
    .max(5),
});

export const listBookingsQuerySchema = z.object({
  store_id: uuid,
  product_id: uuid.optional(),
  order_id: uuid.optional(),
  date_from: dateOnly.optional(),
  date_to: dateOnly.optional(),
  status: z
    .enum(["held", "pending", "confirmed", "arrived", "in_service", "completed", "cancelled", "no_show"])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const updateBookingStatusSchema = z.object({
  store_id: uuid,
  status: z.enum([
    "held",
    "pending",
    "confirmed",
    "arrived",
    "in_service",
    "completed",
    "cancelled",
    "no_show",
  ]),
  cancel_reason: z.string().trim().max(500).nullable().optional(),
  // New start for the whole visit: every item shifts by the same delta. The
  // booking's endsAt is recomputed from the shifted items server-side.
  starts_at: isoDateTime.optional(),
});

export const slotsQuerySchema = z.object({
  store_id: uuid,
  product_id: uuid,
  variant_id: uuid.optional(),
  staff_id: uuid.optional(),
  location_id: uuid.optional(),
  modifier_option_ids: z
    .string()
    .optional()
    .transform((value) => (value ? value.split(",").filter(Boolean) : []))
    .pipe(z.array(uuid).max(20)),
  date: dateOnly,
  days: z.coerce.number().int().min(1).max(7).default(1),
});

export const bookingIdParamsSchema = z.object({ bookingId: uuid });