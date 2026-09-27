import { z } from "zod";

const uuid = z.string().uuid();
const hhmm = z.string().regex(/^\d{2}:\d{2}$/, "Expected HH:mm");

export const reserveBookingSchema = z.object({
  product_id: uuid,
  store_id: uuid,
  slot: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD"),
    startTime: hhmm,
    endTime: hhmm,
  }),
});

export const listBookingsQuerySchema = z
  .object({
    // Sent by BookingsTab (apiRequestWithBusiness) but not by OrderDetails
    // (plain apiRequest); the business is derived from the active store either way.
    business_id: uuid.optional(),
    store_id: uuid,
    product_id: uuid.optional(),
    order_id: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .refine((value) => value.product_id || value.order_id, {
    message: "Provide product_id or order_id",
  });

export const updateBookingStatusSchema = z.object({
  store_id: uuid,
  status: z.enum([
    "pending",
    "confirmed",
    "declined",
    "rescheduled",
    "completed",
    "cancelled",
    "no_show",
  ]),
  decline_reason: z.string().trim().max(500).nullable().optional(),
  booking_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  start_time: hhmm.optional(),
  end_time: hhmm.optional(),
});

export const bookingIdParamsSchema = z.object({ bookingId: uuid });
