export type BookingStatus =
  | "pending"
  | "confirmed"
  | "declined"
  | "rescheduled"
  | "completed"
  | "cancelled"
  | "no_show";

export interface BookingRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly productId: string;
  readonly orderId: string | null;
  readonly customerPartyId: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly customerPhone: string | null;
  readonly bookingDate: string;
  readonly startTime: string;
  readonly endTime: string;
  readonly timezone: string;
  readonly locationType: string | null;
  readonly locationDetails: string | null;
  readonly requiresApproval: boolean;
  readonly durationMinutes: number | null;
  readonly status: BookingStatus;
  readonly declineReason: string | null;
  readonly rescheduledFrom: string | null;
  readonly initiatedBy: "creator" | "customer" | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** snake_case shape the frontend's ServiceBooking type expects. */
export interface ServiceBooking {
  readonly id: string;
  readonly order_id: string | null;
  readonly product_id: string;
  readonly store_id: string;
  readonly customer_id: string | null;
  readonly customer: { name: string; email: string; phone?: string } | null;
  readonly booking_date: string;
  readonly start_time: string;
  readonly end_time: string;
  readonly timezone: string | null;
  readonly location_type: string | null;
  readonly location_details: string | null;
  readonly requires_approval: boolean;
  readonly duration_minutes: number | null;
  readonly status: BookingStatus;
  readonly decline_reason: string | null;
  readonly rescheduled_from: string | null;
  readonly initiated_by: "creator" | "customer" | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface BookingsOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export function toServiceBooking(row: BookingRow): ServiceBooking {
  return {
    id: row.id,
    order_id: row.orderId,
    product_id: row.productId,
    store_id: row.storeId,
    customer_id: row.customerPartyId,
    customer: row.customerName || row.customerEmail
      ? {
          name: row.customerName ?? "",
          email: row.customerEmail ?? "",
          phone: row.customerPhone ?? undefined,
        }
      : null,
    booking_date: row.bookingDate,
    start_time: row.startTime,
    end_time: row.endTime,
    timezone: row.timezone,
    location_type: row.locationType,
    location_details: row.locationDetails,
    requires_approval: row.requiresApproval,
    duration_minutes: row.durationMinutes,
    status: row.status,
    decline_reason: row.declineReason,
    rescheduled_from: row.rescheduledFrom,
    initiated_by: row.initiatedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: iso(row.updatedAt) ?? "",
  };
}
