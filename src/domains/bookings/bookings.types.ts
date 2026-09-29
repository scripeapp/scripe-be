import { utcToLocalDateTime } from "../../shared/tz.js";

export type BookingStatus =
  | "held"
  | "pending"
  | "confirmed"
  | "arrived"
  | "in_service"
  | "completed"
  | "cancelled"
  | "no_show";

export type BookingSource = "dashboard" | "pos" | "online" | "walk_in";

/** Statuses whose interval still blocks the staff slot (exclusion constraint). */
export const ACTIVE_BOOKING_STATUSES: readonly BookingStatus[] = [
  "held",
  "pending",
  "confirmed",
  "arrived",
  "in_service",
];

export interface BookingItemRow {
  readonly id: string;
  readonly businessId: string;
  readonly bookingId: string;
  readonly position: number;
  readonly productId: string;
  readonly variantId: string | null;
  readonly staffId: string | null;
  readonly staffName: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly modifierOptionIds: string[];
  readonly priceMinor: string;
  readonly durationMinutes: number;
  readonly status: BookingStatus;
}

export interface BookingRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly locationId: string | null;
  readonly orderId: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly status: BookingStatus;
  readonly source: BookingSource;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly holdExpiresAt: Date | null;
  readonly manageToken: string | null;
  readonly notes: string | null;
  readonly cancelledReason: string | null;
  readonly requiresApproval: boolean;
  readonly initiatedBy: "creator" | "customer" | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /** Timezone of the location (falling back to the store) for local rendering. */
  readonly timezone: string;
  items: BookingItemRow[];
}

/** snake_case shape the frontend calendar expects. */
export interface ServiceBookingItem {
  readonly product_id: string;
  readonly variant_id: string | null;
  readonly staff_id: string | null;
  readonly staff_name: string | null;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly duration_minutes: number;
  readonly price_minor: string;
  readonly modifier_option_ids: string[];
  readonly status: BookingStatus;
}

export interface ServiceBooking {
  readonly id: string;
  readonly store_id: string;
  readonly location_id: string | null;
  readonly order_id: string | null;
  readonly customer: { name: string; email: string; phone?: string } | null;
  readonly booking_date: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly timezone: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly status: BookingStatus;
  readonly source: BookingSource;
  readonly hold_expires_at: string | null;
  readonly manage_token: string | null;
  readonly notes: string | null;
  readonly cancelled_reason: string | null;
  readonly requires_approval: boolean;
  readonly initiated_by: "creator" | "customer" | null;
  readonly items: ServiceBookingItem[];
  readonly created_at: string;
  readonly updated_at: string;
}

export interface AvailableSlot {
  readonly staff_id: string;
  readonly staff_name: string;
  readonly location_id: string;
  readonly date: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly starts_at: string;
  readonly ends_at: string;
}

export interface ReservedBooking {
  readonly booking_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly hold_expires_at: string;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toServiceBookingItem(row: BookingItemRow): ServiceBookingItem {
  return {
    product_id: row.productId,
    variant_id: row.variantId,
    staff_id: row.staffId,
    staff_name: row.staffName,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    duration_minutes: row.durationMinutes,
    price_minor: row.priceMinor,
    modifier_option_ids: row.modifierOptionIds,
    status: row.status,
  };
}

export function toServiceBooking(row: BookingRow): ServiceBooking {
  return {
    id: row.id,
    store_id: row.storeId,
    location_id: row.locationId,
    order_id: row.orderId,
    customer: row.customerName || row.customerEmail
      ? {
          name: row.customerName ?? "",
          email: row.customerEmail ?? "",
          phone: row.customerPhone ?? undefined,
        }
      : null,
    ...localWindow(row),
    timezone: row.timezone,
    starts_at: row.startsAt.toISOString(),
    ends_at: row.endsAt.toISOString(),
    status: row.status,
    source: row.source,
    hold_expires_at: iso(row.holdExpiresAt),
    manage_token: row.manageToken,
    notes: row.notes,
    cancelled_reason: row.cancelledReason,
    requires_approval: row.requiresApproval,
    initiated_by: row.initiatedBy,
    items: row.items.map(toServiceBookingItem),
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** booking_date/start_time/end_time rendered in the location/store timezone. */
function localWindow(row: BookingRow): { booking_date: string; start_time: string; end_time: string } {
  const start = utcToLocalDateTime(row.startsAt.getTime(), row.timezone);
  const end = utcToLocalDateTime(row.endsAt.getTime(), row.timezone);
  return { booking_date: start.date, start_time: start.time, end_time: end.time };
}

export interface BookingsOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}