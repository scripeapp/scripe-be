import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { posBookingsQuerySchema, posOrderSchema, posPreviewSchema } from "./pos.schemas.js";
import type { PosService } from "./pos.service.js";

export class PosController {
  constructor(private readonly service: PosService) {}

  /** Today's arrived + in-service bookings, ready to open a ticket from. */
  readonly bookings = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const query = posBookingsQuerySchema.parse(request.query);
      const bookings = await this.service.tillBookings(userId, request.requestId, query.store_id);
      ApiResponse.success(response, bookings);
    } catch (error) {
      next(error);
    }
  };

  /** Price a ticket server-side without touching the ledger. */
  readonly preview = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const body = posPreviewSchema.parse(request.body);
      const data = await this.service.preview(
        userId,
        request.requestId,
        body.store_id,
        body.branch_id,
        body.items.map((item) => ({
          productId: item.product_id,
          variantId: item.variant_id ?? null,
          quantity: item.quantity,
          modifierOptionIds: item.selected_modifiers.map((modifier) => modifier.modifier_option_id),
          note: item.note,
        })),
      );
      ApiResponse.success(response, data);
    } catch (error) {
      next(error);
    }
  };

  /** Charge a ticket: create the order, capture payment, and complete an attached booking. */
  readonly charge = async (request: Request, response: Response, next: NextFunction): Promise<void> => {
    try {
      const { userId } = requireAuthContext(request);
      const body = posOrderSchema.parse(request.body);
      const data = await this.service.charge(userId, request.requestId, {
        storeId: body.store_id,
        locationId: body.branch_id,
        paymentMethod: body.payment_method,
        registerShiftId: body.register_shift_id ?? null,
        bookingId: body.booking_id ?? null,
        items: (body.items ?? []).map((item) => ({
          productId: item.product_id,
          variantId: item.variant_id ?? null,
          quantity: item.quantity,
          modifierOptionIds: item.selected_modifiers.map((modifier) => modifier.modifier_option_id),
          note: item.note,
        })),
        tip: body.tip ? { amountMinor: body.tip.amount_minor, staffId: body.tip.staff_id ?? null } : null,
      });
      ApiResponse.success(response, data);
    } catch (error) {
      next(error);
    }
  };
}