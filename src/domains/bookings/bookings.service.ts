import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { anonymousPrincipal, withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./bookings.repository.js";
import { toServiceBooking, type ServiceBooking } from "./bookings.types.js";

const RESERVATION_TTL_MINUTES = 15;

export class BookingsService {
  constructor(private readonly database: Database) {}

  /** Public storefront reservation — no authenticated member. */
  async reserve(
    requestId: string,
    input: { storeId: string; productId: string; slot: { date: string; startTime: string; endTime: string } },
  ): Promise<{ booking_id: string; expires_at: string }> {
    return this.runAnon(requestId, async (context) => {
      const created = await repo.reserveBooking(context, {
        storeId: input.storeId,
        productId: input.productId,
        date: input.slot.date,
        startTime: input.slot.startTime,
        endTime: input.slot.endTime,
        expiresInMinutes: RESERVATION_TTL_MINUTES,
      });
      if (!created) throw notFoundError("Store not found or not active");
      return { booking_id: created.id, expires_at: created.expiresAt.toISOString() };
    });
  }

  async listByProduct(
    userId: string,
    requestId: string,
    storeId: string,
    productId: string,
    page: number,
    limit: number,
  ): Promise<ServiceBooking[]> {
    const businessId = await this.resolveBusinessForMember(userId, requestId, storeId);
    return this.runAuthed(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, "order.read");
      return (await repo.listByProduct(context, businessId, storeId, productId, page, limit)).map(toServiceBooking);
    });
  }

  async listByOrder(userId: string, requestId: string, storeId: string, orderId: string): Promise<ServiceBooking[]> {
    const businessId = await this.resolveBusinessForMember(userId, requestId, storeId);
    return this.runAuthed(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, "order.read");
      return (await repo.listByOrder(context, businessId, storeId, orderId)).map(toServiceBooking);
    });
  }

  async updateStatus(
    userId: string,
    requestId: string,
    storeId: string,
    bookingId: string,
    patch: { status: string; declineReason?: string | null; bookingDate?: string; startTime?: string; endTime?: string },
  ): Promise<ServiceBooking> {
    const businessId = await this.resolveBusinessForMember(userId, requestId, storeId);
    return this.runAuthed(userId, requestId, businessId, async (context) => {
      await authorization.requirePermission(context, businessId, "order.read");
      const existing = await repo.findById(context, businessId, bookingId);
      if (!existing) throw notFoundError("Booking not found");
      const rescheduledFrom =
        patch.status === "rescheduled" && patch.bookingDate ? existing.bookingDate : undefined;
      const updated = await repo.updateStatus(context, businessId, storeId, bookingId, { ...patch, rescheduledFrom });
      if (!updated) throw notFoundError("Booking not found");
      return toServiceBooking(updated);
    });
  }

  /**
   * Authenticated resolution: read the store as the calling member (works on
   * draft/unpublished stores via the stores_read permission policy).
   */
  private async resolveBusinessForMember(userId: string, requestId: string, storeId: string): Promise<string> {
    const businessId = await this.runAuthed(userId, requestId, null, (context) =>
      repo.businessIdForStore(context, storeId),
    );
    if (!businessId) throw notFoundError("Store not found");
    return businessId;
  }

  private async runAnon<T>(requestId: string, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
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
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(requestId, userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
