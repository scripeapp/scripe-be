export interface StaffProfileRow {
  readonly id: string;
  readonly businessId: string;
  readonly membershipId: string | null;
  readonly partyId: string | null;
  readonly displayName: string;
  readonly photoUploadId: string | null;
  readonly isBookable: boolean;
  readonly commissionPercent: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StaffServiceRow {
  readonly id: string;
  readonly staffId: string;
  readonly productId: string;
  readonly variantId: string | null;
  readonly durationOverrideMinutes: number | null;
}

export interface StaffScheduleRow {
  readonly id: string;
  readonly staffId: string;
  readonly locationId: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
}

export interface ScheduleExceptionRow {
  readonly id: string;
  readonly businessId: string;
  readonly staffId: string | null;
  readonly locationId: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly kind: "off" | "extra";
  readonly reason: string | null;
  readonly createdAt: Date;
}

export interface StaffMember {
  readonly id: string;
  readonly membershipId: string | null;
  readonly partyId: string | null;
  readonly displayName: string;
  readonly photoUploadId: string | null;
  readonly isBookable: boolean;
  readonly commissionPercent: number;
  readonly services: readonly Omit<StaffServiceRow, "staffId">[];
  readonly schedule: readonly Omit<StaffScheduleRow, "staffId">[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ScheduleException {
  readonly id: string;
  readonly staffId: string | null;
  readonly locationId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: "off" | "extra";
  readonly reason: string | null;
}

export interface StaffOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}

export interface CommissionReportRow {
  readonly staffId: string;
  readonly displayName: string;
  readonly commissionPercent: number;
  readonly revenueMinor: string;
  readonly tipsMinor: string;
  readonly completedCount: string;
}

export interface StaffCommissionReport {
  readonly staffId: string;
  readonly displayName: string;
  readonly commissionPercent: number;
  readonly revenueMinor: number;
  readonly tipsMinor: number;
  readonly commissionMinor: number;
  readonly completedBookings: number;
}
