/**
 * Booking Controller
 * Handles HTTP endpoints for service booking management
 */

import { Request, Response } from "express";
import { BookingService } from "../services/booking.service";
import { ServiceBooking } from "../types/store";
import { supabaseAdmin } from "../config/supabase";
import { generateBookingICS } from "../utils/ics-generator";

type BookingStatus = ServiceBooking["status"];
import ApiResponse from "../utils/apiResponse";
import { SupabaseRequest } from "../types/http";

class BookingController {
  /**
   * Get store bookings with optional filters
   * GET /api/store/bookings?store_id=...&start_date=...&end_date=...&status=...
   */
  async getStoreBookings(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { store_id, start_date, end_date, status, order_id, product_id, page, limit } =
        req.query as {
          store_id: string;
          start_date?: string;
          end_date?: string;
          status?: string;
          order_id?: string;
          product_id?: string;
          page?: string;
          limit?: string;
        };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new BookingService(authReq.supabase);
      const result = await service.getStoreBookings({
        store_id,
        start_date,
        end_date,
        status,
        order_id,
        product_id,
        page: page ? parseInt(page, 10) : undefined,
        limit: limit ? parseInt(limit, 10) : undefined,
      });

      return ApiResponse.success(
        res,
        "Bookings retrieved successfully",
        result,
      );
    } catch (error: any) {
      console.error("[BookingController.getStoreBookings]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get a single booking
   * GET /api/store/bookings/:id?store_id=...
   */
  async getBooking(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { bookingId } = req.params;
      const { store_id } = req.query as { store_id: string };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new BookingService(authReq.supabase);
      const booking = await service.getBooking(bookingId, store_id);

      return ApiResponse.success(
        res,
        "Booking retrieved successfully",
        booking,
      );
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      console.error("[BookingController.getBooking]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Update booking status
   * PATCH /api/store/bookings/:id
   * Body: { store_id, status, decline_reason? }
   */
  async updateBookingStatus(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { bookingId } = req.params;
      const { store_id, status, decline_reason } = req.body as {
        store_id: string;
        status: BookingStatus;
        decline_reason?: string;
      };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      if (!status) {
        return ApiResponse.badRequest(res, "status is required");
      }

      const validStatuses: BookingStatus[] = [
        "pending",
        "confirmed",
        "declined",
        "rescheduled",
        "completed",
        "cancelled",
        "no_show",
      ];
      if (!validStatuses.includes(status)) {
        return ApiResponse.badRequest(
          res,
          `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        );
      }

      // Require decline_reason when declining
      if (status === "declined" && !decline_reason) {
        return ApiResponse.badRequest(
          res,
          "decline_reason is required when declining a booking",
        );
      }

      const service = new BookingService(authReq.supabase);
      const booking = await service.updateBookingStatus(
        bookingId,
        store_id,
        status,
        decline_reason,
      );

      return ApiResponse.success(
        res,
        "Booking status updated successfully",
        booking,
      );
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      console.error("[BookingController.updateBookingStatus]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Reschedule a booking
   * POST /api/store/bookings/:id/reschedule
   * Body: { store_id, new_date, new_start_time, new_end_time, initiated_by }
   */
  async rescheduleBooking(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { bookingId } = req.params;
      const { store_id, new_date, new_start_time, new_end_time, initiated_by } =
        req.body as {
          store_id: string;
          new_date: string;
          new_start_time: string;
          new_end_time: string;
          initiated_by?: "creator" | "customer";
        };

      if (!store_id || !new_date || !new_start_time || !new_end_time) {
        return ApiResponse.badRequest(
          res,
          "store_id, new_date, new_start_time, and new_end_time are required",
        );
      }

      // Validate date format (YYYY-MM-DD)
      if (!/^\d{4}-\d{2}-\d{2}$/.test(new_date)) {
        return ApiResponse.badRequest(
          res,
          "new_date must be in YYYY-MM-DD format",
        );
      }

      // Validate time format (HH:mm)
      if (
        !/^\d{2}:\d{2}$/.test(new_start_time) ||
        !/^\d{2}:\d{2}$/.test(new_end_time)
      ) {
        return ApiResponse.badRequest(res, "Times must be in HH:mm format");
      }

      const service = new BookingService(authReq.supabase);
      const booking = await service.rescheduleBooking(
        bookingId,
        store_id,
        new_date,
        new_start_time,
        new_end_time,
        initiated_by || "creator",
      );

      return ApiResponse.success(
        res,
        "Booking rescheduled successfully",
        booking,
      );
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      if (error.statusCode === 400) {
        return ApiResponse.badRequest(res, error.message);
      }
      console.error("[BookingController.rescheduleBooking]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get upcoming bookings for a store
   * GET /api/store/bookings/upcoming?store_id=...&limit=...
   */
  async getUpcomingBookings(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { store_id, limit } = req.query as {
        store_id: string;
        limit?: string;
      };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new BookingService(authReq.supabase);
      const bookings = await service.getUpcomingBookings(
        store_id,
        limit ? parseInt(limit, 10) : 10,
      );

      return ApiResponse.success(
        res,
        "Upcoming bookings retrieved successfully",
        bookings,
      );
    } catch (error: any) {
      console.error("[BookingController.getUpcomingBookings]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Download booking calendar file
   * GET /api/store/bookings/:id/calendar?store_id=...
   */
  async downloadCalendar(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { bookingId } = req.params;
      const { store_id } = req.query as { store_id: string };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new BookingService(authReq.supabase);
      const { icsContent, filename } = await service.generateBookingCalendar(
        bookingId,
        store_id,
      );

      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${filename}"`,
      );
      return res.send(icsContent);
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      console.error("[BookingController.downloadCalendar]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Send reminder for a booking
   * POST /api/store/bookings/:id/reminder
   * Body: { store_id }
   */
  async sendReminder(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { bookingId } = req.params;
      const { store_id } = req.body as { store_id: string };

      if (!store_id) {
        return ApiResponse.badRequest(res, "store_id is required");
      }

      const service = new BookingService(authReq.supabase);
      await service.sendReminder(bookingId, store_id);

      return res.status(200).json({
        success: true,
        message: "Reminder sent",
      });
    } catch (error: any) {
      if (error.statusCode === 404) {
        return ApiResponse.notFound(res, error.message);
      }
      if (error.statusCode === 400) {
        return ApiResponse.badRequest(res, error.message);
      }
      console.error("[BookingController.sendReminder]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Reserve a slot for 15 minutes while the customer fills in checkout details.
   * POST /api/store/bookings/reserve
   * Body: { product_id, store_id, slot }
   * Public — no auth required
   */
  async reserveBookingSlot(req: Request, res: Response) {
    try {
      const { product_id, store_id, slot } = req.body;

      if (!product_id || !store_id || !slot?.date || !slot?.startTime || !slot?.endTime) {
        return ApiResponse.badRequest(
          res,
          "product_id, store_id, and slot (date, startTime, endTime) are required",
        );
      }

      const service = new BookingService(supabaseAdmin);
      const result = await service.reserveBookingSlot({ product_id, store_id, slot });

      return ApiResponse.success(res, "Slot reserved", result);
    } catch (error: any) {
      if (error.statusCode === 409) {
        return res.status(409).json({ success: false, message: error.message });
      }
      console.error("[BookingController.reserveBookingSlot]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Initiate payment for a standalone booking (not via store cart)
   * POST /api/store/bookings/initiate-payment
   * Body: { product_id, store_id, slot, customer, notes?, callback_url? }
   * Public — no auth required
   */
  async initiateBookingPayment(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;
      const { product_id, store_id, slot, customer, notes, callback_url } =
        req.body;

      if (
        !product_id ||
        !store_id ||
        !slot ||
        !customer?.email ||
        !customer?.name
      ) {
        return ApiResponse.badRequest(
          res,
          "product_id, store_id, slot, customer name and customer email are required",
        );
      }

      if (!slot.date || !slot.startTime || !slot.endTime) {
        return ApiResponse.badRequest(
          res,
          "slot must include date, startTime and endTime",
        );
      }

      // supabaseAdmin: public route — anon client, auth.uid() is null, RLS blocks the insert.
      const service = new BookingService(supabaseAdmin);
      const result = await service.initiateBookingPayment({
        product_id,
        store_id,
        slot,
        customer,
        notes,
        callback_url,
      });

      // Free service — booking already confirmed
      if (!result.authorization_url) {
        return ApiResponse.created(res, "Booking confirmed", {
          booking_id: result.booking_id,
          amount: 0,
          requires_payment: false,
        });
      }

      return ApiResponse.success(res, "Payment initiated", {
        authorization_url: result.authorization_url,
        reference: result.reference,
        booking_id: result.booking_id,
        amount: result.amount,
        requires_payment: true,
      });
    } catch (error: any) {
      if (error.statusCode === 400)
        return ApiResponse.badRequest(res, error.message);
      if (error.statusCode === 404)
        return ApiResponse.notFound(res, error.message);
      if (error.statusCode === 422)
        return res.status(422).json({ success: false, message: error.message });
      console.error("[BookingController.initiateBookingPayment]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get a booking by ID without authentication (for post-payment success page)
   * GET /api/store/public/booking/:bookingId
   * Public — no auth required
   */
  async getPublicBooking(req: Request, res: Response) {
    try {
      const { bookingId } = req.params;
      const { data, error } = await supabaseAdmin
        .from("service_bookings")
        .select("id, status, booking_date, start_time, end_time, customer_name, approval_required, product:products(name), store:stores(name, slug)")
        .eq("id", bookingId)
        .single();

      if (error || !data) return ApiResponse.notFound(res, "Booking not found");
      return ApiResponse.success(res, "Booking retrieved", data);
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }

  async getPublicBookingCalendar(req: Request, res: Response) {
    try {
      const { bookingId } = req.params;
      const { data, error } = await supabaseAdmin
        .from("service_bookings")
        .select("booking_date, start_time, end_time, notes, location_details, customer_name, customer_email, product:products(name), store:stores(name)")
        .eq("id", bookingId)
        .single();

      if (error || !data) return ApiResponse.notFound(res, "Booking not found");

      const product = (data as any).product;
      const store = (data as any).store;

      const icsContent = generateBookingICS({
        storeName: store?.name || "Store",
        productName: product?.name || "Service",
        bookingDate: data.booking_date,
        startTime: data.start_time,
        endTime: data.end_time,
        location: data.location_details || undefined,
        customerName: data.customer_name || undefined,
        customerEmail: data.customer_email || undefined,
        notes: data.notes || undefined,
      });

      const filename = `booking-${bookingId}.ics`;
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      return res.send(icsContent);
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }

  /**
   * Get customer's own bookings
   * GET /api/store/bookings/my
   */
  async getMyBookings(req: Request, res: Response) {
    try {
      const authReq = req as SupabaseRequest;

      // Get user's email from the authenticated user
      const { data: user, error: userError } =
        await authReq.supabase.auth.getUser();

      if (userError || !user?.user?.email) {
        return ApiResponse.unauthorized(res, "Unable to identify user");
      }

      const service = new BookingService(authReq.supabase);
      const bookings = await service.getCustomerBookings(user.user.email);

      return ApiResponse.success(
        res,
        "Bookings retrieved successfully",
        bookings,
      );
    } catch (error: any) {
      console.error("[BookingController.getMyBookings]", error);
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export const bookingController = new BookingController();
