import { Request, Response } from "express";
import { SupabaseRequest } from "../types/http";
import { SchedulingService } from "../services/scheduling.service";
import ApiResponse from "../utils/apiResponse";

// ============================================================================
// Event Types
// ============================================================================

export const seedDefaults = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const result = await service.seedDefaults(req.user_id!, req.businessId);
    return ApiResponse.success(res, result.seeded ? "Defaults seeded" : "Already set up", result);
  } catch (err: any) {
    return ApiResponse.serverError(res, err.message);
  }
};

export const listEventTypes = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const businessId = (req.query.business_id as string) || undefined;
    const data = await service.listEventTypes(req.user_id!, businessId);
    return ApiResponse.success(res, "Event types retrieved", data);
  } catch (err: any) {
    return ApiResponse.serverError(res, err.message);
  }
};

export const getEventType = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.getEventType(req.params.id, req.user_id!);
    return ApiResponse.success(res, "Event type retrieved", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const createEventType = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.createEventType(req.user_id!, req.businessId, req.body);
    return ApiResponse.created(res, "Event type created", data);
  } catch (err: any) {
    if (err.statusCode === 409) return ApiResponse.conflict(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const updateEventType = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.updateEventType(req.params.id, req.user_id!, req.body);
    return ApiResponse.success(res, "Event type updated", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    if (err.statusCode === 409) return ApiResponse.conflict(res, err.message);
    console.error("[Scheduling] updateEventType error:", err);
    return ApiResponse.serverError(res, err.message ?? "Failed to update event type");
  }
};

export const deleteEventType = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    await service.deleteEventType(req.params.id, req.user_id!);
    return ApiResponse.success(res, "Event type deleted");
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    if (err.statusCode === 400) return ApiResponse.badRequest(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

// ============================================================================
// Public Endpoints (no auth)
// ============================================================================

export const getPublicEventType = async (req: Request, res: Response) => {
  try {
    const { businessSlug, slug } = req.params;
    const service = new SchedulingService(req as any);
    const data = await service.getPublicEventType(businessSlug, slug);
    return ApiResponse.success(res, "Event type retrieved", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const getPublicSlots = async (req: Request, res: Response) => {
  try {
    const { businessSlug, slug } = req.params;
    const { date } = req.query as { date: string };

    if (!date) return ApiResponse.badRequest(res, "date query param required (YYYY-MM-DD)");

    const service = new SchedulingService(req as any);
    const slots = await service.getAvailableSlots(businessSlug, slug, date);
    return ApiResponse.success(res, "Slots retrieved", slots);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const createBooking = async (req: Request, res: Response) => {
  try {
    const service = new SchedulingService(req as any);
    const data = await service.createBooking(req.body);
    return ApiResponse.created(res, "Booking confirmed", data);
  } catch (err: any) {
    if (err.statusCode === 400) return ApiResponse.badRequest(res, err.message);
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    if (err.statusCode === 409) return ApiResponse.conflict(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const verifySchedulingPayment = async (req: Request, res: Response) => {
  try {
    const { reference, booking_id } = req.query as { reference?: string; booking_id?: string };
    if (!reference) return ApiResponse.badRequest(res, "reference is required");

    // Look up booking by payment_reference to confirm status
    const { supabaseAdmin } = await import("../config/supabaseAdmin");
    const query = supabaseAdmin!
      .from("scheduled_bookings")
      .select("id, status, payment_status, event_type_id, attendee_name, booking_date, start_time");

    const { data: booking } = booking_id
      ? await query.eq("id", booking_id).maybeSingle()
      : await query.eq("payment_reference", reference).maybeSingle();

    if (!booking) return ApiResponse.notFound(res, "Booking not found");

    if (booking.payment_status === "paid") {
      return ApiResponse.success(res, "Payment confirmed", {
        message: "Your booking has been confirmed! Check your email for details.",
        booking_id: booking.id,
        status: booking.status,
      });
    }

    // Payment not yet confirmed by webhook — tell frontend to wait or contact support
    return ApiResponse.success(res, "Payment pending", {
      message: "Payment received. Your booking will be confirmed shortly.",
      booking_id: booking.id,
      status: booking.status,
    });
  } catch (err: any) {
    return ApiResponse.serverError(res, err.message);
  }
};

// ============================================================================
// Bookings (authenticated — host view)
// ============================================================================

export const listBookings = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const { status, upcoming } = req.query as { status?: string; upcoming?: string };
    const data = await service.listBookings(req.user_id!, {
      status,
      upcoming: upcoming === "true",
    });
    return ApiResponse.success(res, "Bookings retrieved", data);
  } catch (err: any) {
    return ApiResponse.serverError(res, err.message);
  }
};

export const confirmBooking = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.confirmBooking(req.params.id, req.user_id!);
    return ApiResponse.success(res, "Booking confirmed", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const cancelBooking = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.cancelBooking(req.params.id, req.user_id!, req.body.reason);
    return ApiResponse.success(res, "Booking cancelled", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const checkInBooking = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.checkInBooking(req.params.id, req.user_id!);
    return ApiResponse.success(res, "Booking checked in", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const deleteBooking = async (req: SupabaseRequest, res: Response) => {
  try {
    const service = new SchedulingService(req.supabase!);
    const data = await service.deleteBooking(req.params.id, req.user_id!);
    return ApiResponse.success(res, "Booking deleted", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};

export const cancelByToken = async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    if (!token) return ApiResponse.badRequest(res, "cancel token required");
    const service = new SchedulingService(req as any);
    const data = await service.cancelByToken(token);
    return ApiResponse.success(res, "Booking cancelled", data);
  } catch (err: any) {
    if (err.statusCode === 404) return ApiResponse.notFound(res, err.message);
    return ApiResponse.serverError(res, err.message);
  }
};
