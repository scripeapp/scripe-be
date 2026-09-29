import { randomBytes } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./bookings.repository.js";
import { toServiceBooking, type AvailableSlot, type BookingStatus, type ReservedBooking, type ServiceBooking } from "./bookings.types.js";
import * as slots from "./slots.js";

const DEFAULT_HOLD_MINUTES = 10;
const DEFAULT_TIMEZONE = "Africa/Lagos";

const TRANSITIONS: Record<BookingStatus, readonly BookingStatus[]> = {
  held: ["pending", "confirmed", "cancelled"],
  pending: ["confirmed", "cancelled"],
  confirmed: ["arrived", "in_service", "completed", "cancelled", "no_show"],
  arrived: ["in_service", "completed", "cancelled"],
  in_service: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  no_show: [],
};

export class BookingsService {
  constructor(private readonly database: Database) {}

  /** Public storefront reservation — no authenticated member. */
  async reserve(
    requestId: string,
    input: {
      storeId: string;
      productId: string;
      variantId: string | null;
      staffId: string;
      locationId: string | null;
      startsAt: string;
      customerName?: string;
      customerEmail?: string;
      customerPhone?: string;
      manageToken?: string;
      holdMinutes?: number;
    },
  ): Promise<ReservedBooking> {
    return this.runAnon(requestId, async (context) => {
      const manageToken = input.manageToken ?? randomBytes(16).toString("hex");
      const result = await repo.reserveFromPublic(context, {
        ...input,
        manageToken,
        holdMinutes: input.holdMinutes ?? DEFAULT_HOLD_MINUTES,
      });
      if (result.error || !result.id || !result.startsAt || !result.endsAt || !result.holdExpiresAt) {
        throw this.reserveFailure(result.error ?? "unexpected");
      }
      return {
        booking_id: result.id,
        starts_at: result.startsAt.toISOString(),
        ends_at: result.endsAt.toISOString(),
        hold_expires_at: result.holdExpiresAt.toISOString(),
      };
    });
  }

  /**
   * A booking the business makes itself. Unlike the storefront hold it is
   * confirmed straight away, ignores the customer-facing notice and advance
   * limits, and can hold several services back to back. The exclusion
   * constraint still refuses double-booking a staff member.
   */
  async create(
    userId: string,
    requestId: string,
    storeId: string,
    input: {
      locationId: string | null;
      startsAt: string;
      source: "dashboard" | "walk_in" | "pos";
      notes: string | null;
      customerName: string | null;
      customerEmail: string | null;
      customerPhone: string | null;
      items: { productId: string; variantId: string | null; staffId: string; modifierOptionIds: string[] }[];
    },
  ): Promise<ServiceBooking> {
    return this.forBusiness(userId, requestId, storeId, "booking.create", async (context, businessId) => {
      const locationId = await repo.resolveStoreLocation(context, businessId, storeId, input.locationId);
      if (!locationId) throw validationError("Unknown booking location.");

      let cursor = new Date(Date.parse(input.startsAt));
      cursor.setUTCSeconds(0, 0);
      const items: repo.NewBookingItem[] = [];
      for (const item of input.items) {
        const check = await repo.serviceStaffCheck(context, businessId, item.productId, item.variantId, item.staffId);
        if (!check) throw validationError("This item is not bookable as a service.");
        if (check.baseDuration === null) throw validationError("Set this service's duration before booking it.");
        if (!check.bookable) throw validationError("This staff member is currently unavailable.");
        if (!check.performs) throw validationError("This staff member does not offer this service.");
        const extra = await slots.modifierExtraMinutes(context, businessId, item.modifierOptionIds);
        const durationMinutes = (check.durationOverride ?? check.baseDuration) + extra;
        const endsAt = new Date(cursor.getTime() + durationMinutes * 60 * 1000);
        items.push({ ...item, startsAt: cursor, endsAt, durationMinutes });
        cursor = endsAt;
      }

      let bookingId: string;
      try {
        bookingId = await repo.insertStaffBooking(context, {
          businessId,
          storeId,
          locationId,
          source: input.source,
          customerName: input.customerName,
          customerEmail: input.customerEmail,
          customerPhone: input.customerPhone,
          notes: input.notes,
          manageToken: randomBytes(16).toString("hex"),
          items,
        });
      } catch (error) {
        const normalized = error instanceof DatabaseError ? error : normalizeDatabaseError(error);
        if (normalized instanceof DatabaseError && normalized.kind === "exclusion-violation") {
          throw conflictError("That staff member is already booked for the requested time.");
        }
        throw error;
      }
      const booking = await repo.findById(context, businessId, bookingId);
      if (!booking) throw notFoundError("Booking not found");
      return toServiceBooking(booking);
    });
  }

  async list(
    userId: string,
    requestId: string,
    storeId: string,
    filters: repo.BookingListFilters,
    page: number,
    limit: number,
  ): Promise<ServiceBooking[]> {
    return this.forBusiness(userId, requestId, storeId, "booking.read", async (context, businessId) => {
      const rows = await repo.listBookings(context, businessId, storeId, filters, limit, (page - 1) * limit);
      return rows.map(toServiceBooking);
    });
  }

  async listByOrder(userId: string, requestId: string, storeId: string, orderId: string): Promise<ServiceBooking[]> {
    return this.forBusiness(userId, requestId, storeId, "booking.read", async (context, businessId) => {
      const rows = await repo.listBookings(context, businessId, storeId, { orderId }, 100, 0);
      return rows.map(toServiceBooking);
    });
  }

  async updateStatus(
    userId: string,
    requestId: string,
    storeId: string,
    bookingId: string,
    patch: { status: BookingStatus; cancelReason?: string | null; startsAt?: string },
  ): Promise<ServiceBooking> {
    return this.forBusiness(userId, requestId, storeId, "booking.update", async (context, businessId) => {
      const existing = await repo.findById(context, businessId, bookingId);
      if (!existing) throw notFoundError("Booking not found");
      this.assertTransition(existing.status, patch.status);

      let shiftedStart: Date | null = null;
      let shiftedEnd: Date | null = null;
      if (patch.startsAt) {
        const deltaMs = Date.parse(patch.startsAt) - existing.startsAt.getTime();
        const shifts = existing.items.map((item) => ({
          id: item.id,
          startsAt: new Date(item.startsAt.getTime() + deltaMs),
          endsAt: new Date(item.endsAt.getTime() + deltaMs),
        }));
        const first = shifts[0];
        let newStart = first?.startsAt ?? existing.startsAt;
        let newEnd = first?.endsAt ?? existing.endsAt;
        for (const shift of shifts) {
          if (shift.startsAt < newStart) newStart = shift.startsAt;
          if (shift.endsAt > newEnd) newEnd = shift.endsAt;
        }
        shiftedStart = newStart;
        shiftedEnd = newEnd;
        try {
          await repo.shiftItems(context, businessId, bookingId, shifts);
        } catch (error) {
          if (error instanceof DatabaseError && error.kind === "exclusion-violation") {
            throw conflictError("That staff member is already booked for the requested time.");
          }
          throw error;
        }
      }

      const updated = await repo.updateBookingStatus(context, businessId, storeId, bookingId, {
        status: patch.status,
        cancelReason:
          patch.status === "cancelled" ? patch.cancelReason ?? null : undefined,
        startsAt: shiftedStart ?? undefined,
        endsAt: shiftedEnd ?? undefined,
      });
      if (!updated) throw notFoundError("Booking not found");
      return toServiceBooking(updated);
    });
  }

  async availableSlots(
    userId: string,
    requestId: string,
    storeId: string,
    input: {
      productId: string;
      variantId: string | null;
      staffId: string | null;
      locationId: string | null;
      modifierOptionIds?: readonly string[];
      date: string;
      days: number;
    },
  ): Promise<{ date: string; days: number; timezone: string; slots: AvailableSlot[] }> {
    return this.forBusiness(userId, requestId, storeId, "booking.read", async (context, businessId) => {
      const settings = await slots.serviceSettings(context, businessId, input.productId);
      if (!settings) throw notFoundError("Service not found");

      const staff = await slots.bookableStaff(
        context,
        businessId,
        input.productId,
        input.variantId,
        input.staffId,
      );
      const staffIds = staff.map((member) => member.staffId);
      const fromMs = this.windowStart(input.date, -1);
      const toMs = this.windowStart(input.date, input.days + 2);

      const [schedules, exceptions, occupied, unavailableLocationIds, extraMinutes] = await Promise.all([
        slots.scheduleEntries(context, businessId, staffIds, input.locationId),
        slots.exceptionEntries(context, businessId, staffIds, fromMs, toMs),
        slots.occupiedRanges(context, businessId, staffIds, fromMs, toMs, null),
        slots.unavailableLocations(context, businessId, input.productId),
        slots.modifierExtraMinutes(context, businessId, input.modifierOptionIds ?? []),
      ]);

      const generated = slots.computeSlots({
        fromDate: input.date,
        dayCount: input.days,
        settings,
        staff,
        schedules,
        exceptions,
        occupied,
        locationFilter: input.locationId,
        staffFilter: input.staffId,
        nowMilliseconds: Date.now(),
        extraMinutes,
        unavailableLocationIds,
      });

      const timezone = (await repo.storeTimezone(context, storeId)) ?? DEFAULT_TIMEZONE;
      return { date: input.date, days: input.days, timezone, slots: generated };
    });
  }

  private windowStart(date: string, offsetDays: number): number {
    const start = Date.parse(`${date}T00:00:00.000Z`);
    return start + offsetDays * 24 * 60 * 60 * 1000;
  }

  private assertTransition(from: BookingStatus, to: BookingStatus): void {
    if (from === to) return;
    if (!TRANSITIONS[from].includes(to)) {
      throw validationError(`Cannot move a booking from ${from} to ${to}.`);
    }
  }

  private reserveFailure(error: string | null): AppError {
    switch (error) {
      case "slot_taken":
        return conflictError("That time slot was just taken. Please choose another.");
      case "store_inactive":
        return notFoundError("Store not found or not active");
      case "product_not_service":
        return validationError("This item is not bookable as a service.");
      case "staff_unavailable":
        return validationError("This staff member is currently unavailable.");
      case "staff_does_not_perform":
        return validationError("This staff member does not offer this service.");
      case "location_unknown":
        return validationError("Unknown booking location.");
      case "too_late":
        return validationError("That time is too soon before the appointment to reserve.");
      case "too_far":
        return validationError("That date is outside the booking window.");
      default:
        return validationError("We could not complete your reservation. Please try again.");
    }
  }

  /**
   * Authenticated resolution: read the store as the calling member (works on
   * draft/unpublished stores via the stores_read permission policy), then run
   * the operation under the booking.x permission.
   */
  private async forBusiness<T>(
    userId: string,
    requestId: string,
    storeId: string,
    permission: string,
    work: (context: DatabaseContext, businessId: string) => Promise<T>,
  ): Promise<T> {
    const businessId = await this.runAuthed(userId, requestId, null, (context) =>
      repo.businessIdForStore(context, storeId),
    );
    if (!businessId) throw notFoundError("Store not found");
    return this.runAuthed(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, permission);
      return work(context, businessId);
    });
  }

  private async runAnon<T>(requestId: string, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, anonymousPrincipal(requestId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }

  private async runAuthed<T>(
    userId: string,
    requestId: string,
    businessId: string | null,
    work: (context: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(requestId, userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}