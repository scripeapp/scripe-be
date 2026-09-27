import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import {
  bookingIdParamsSchema,
  listBookingsQuerySchema,
  reserveBookingSchema,
  updateBookingStatusSchema,
} from "./bookings.schemas.js";
import type { BookingsService } from "./bookings.service.js";

export class BookingsController {
  constructor(private readonly service: BookingsService) {}

  /** Public storefront reservation — no auth. */
  readonly reserve = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { product_id, store_id, slot } = reserveBookingSchema.parse(request.body);
      const data = await this.service.reserve(request.requestId, { storeId: store_id, productId: product_id, slot });
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
      const bookings = await this.service.listByProduct(
        userId,
        request.requestId,
        query.store_id,
        query.product_id!,
        query.page,
        query.limit,
      );
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
        declineReason: body.decline_reason,
        bookingDate: body.booking_date,
        startTime: body.start_time,
        endTime: body.end_time,
      });
      ApiResponse.success(response, booking);
    } catch (error) {
      next(error);
    }
  };
}
