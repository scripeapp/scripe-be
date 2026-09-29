import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  bookingIdParamsSchema,
  listBookingsQuerySchema,
  reserveBookingSchema,
  slotsQuerySchema,
  updateBookingStatusSchema,
} from "./bookings.schemas.js";
import type { BookingsService } from "./bookings.service.js";

export class BookingsController {
  constructor(private readonly service: BookingsService) {}

  /** Public storefront reservation — no auth. */
  readonly reserve = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const body = reserveBookingSchema.parse(request.body);
      const data = await this.service.reserve(request.requestId, {
        storeId: body.store_id,
        productId: body.product_id,
        variantId: body.variant_id ?? null,
        staffId: body.staff_id,
        locationId: body.location_id ?? null,
        startsAt: body.starts_at,
        manageToken: body.manage_token,
        holdMinutes: body.hold_minutes,
        customerName: body.customer?.name ?? undefined,
        customerEmail: body.customer?.email ?? undefined,
        customerPhone: body.customer?.phone,
      });
      ApiResponse.success(response, data, 201);
    } catch (error) {
      next(error);
    }
  };

  readonly list = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const query = listBookingsQuerySchema.parse(request.query);

      if (query.order_id) {
        // OrderDetails expects res.data to be the array directly.
        const bookings = await this.service.listByOrder(userId, request.requestId, query.store_id, query.order_id);
        ApiResponse.success(response, bookings);
        return;
      }

      // BookingsTab expects res.data.data (array) + res.data.meta.
      const bookings = await this.service.list(userId, request.requestId, query.store_id, {
        productId: query.product_id,
        dateFrom: query.date_from,
        dateTo: query.date_to,
        status: query.status,
      }, query.page, query.limit);
      ApiResponse.success(response, {
        data: bookings,
        meta: { total: bookings.length, totalPages: bookings.length < query.limit ? query.page : query.page + 1 },
      });
    } catch (error) {
      next(error);
    }
  };

  readonly updateStatus = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const { bookingId } = bookingIdParamsSchema.parse(request.params);
      const body = updateBookingStatusSchema.parse(request.body);
      const booking = await this.service.updateStatus(userId, request.requestId, body.store_id, bookingId, {
        status: body.status,
        cancelReason: body.cancel_reason,
        startsAt: body.starts_at,
      });
      ApiResponse.success(response, booking);
    } catch (error) {
      next(error);
    }
  };

  readonly slots = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const query = slotsQuerySchema.parse(request.query);
      const slots = await this.service.availableSlots(userId, request.requestId, query.store_id, {
        productId: query.product_id,
        variantId: query.variant_id ?? null,
        staffId: query.staff_id ?? null,
        locationId: query.location_id ?? null,
        date: query.date,
        days: query.days,
      });
      ApiResponse.success(response, slots);
    } catch (error) {
      next(error);
    }
  };
}