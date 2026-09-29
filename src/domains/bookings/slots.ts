import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { localDateTimeToUtcMilliseconds, localDateWeekday, utcToLocalDateTime } from "../../shared/tz.js";
import type { AvailableSlot } from "./bookings.types.js";
import { ACTIVE_BOOKING_STATUSES } from "./bookings.types.js";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export interface SlotSettings {
  readonly durationMinutes: number;
  readonly bufferBeforeMinutes: number;
  readonly bufferAfterMinutes: number;
  readonly minNoticeMinutes: number;
  readonly maxAdvanceDays: number;
  readonly slotIntervalMinutes: number;
  readonly locationType: string;
  readonly requiresApproval: boolean;
}

export interface ServiceStaff {
  readonly staffId: string;
  readonly staffName: string;
  /** This person's own duration for the service, when it differs from the product's. */
  readonly durationOverrideMinutes: number | null;
}

export interface ScheduleEntry {
  readonly staffId: string;
  readonly locationId: string;
  readonly timezone: string;
  readonly weekday: number;
  readonly startTime: string;
  readonly endTime: string;
}

export interface ExceptionEntry {
  readonly staffId: string | null;
  readonly locationId: string | null;
  readonly timezone: string | null;
  readonly kind: "off" | "extra";
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface OccupiedRange {
  readonly staffId: string;
  readonly paddedStartsAt: Date;
  readonly paddedEndsAt: Date;
}

export async function serviceSettings(
  context: DatabaseContext,
  businessId: string,
  productId: string,
): Promise<SlotSettings | undefined> {
  const result = await sql<SlotSettings>`
    select pss."durationMinutes", pss."bufferBeforeMinutes", pss."bufferAfterMinutes",
           pss."minNoticeMinutes", pss."maxAdvanceDays", pss."slotIntervalMinutes",
           pss."locationType", pss."requiresApproval"
    from app.products p
    join app.product_service_settings pss on pss."productId" = p."id"
    where p."id" = ${productId}::uuid
      and p."businessId" = ${businessId}::uuid
      and p."productType" = 'service'
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function bookableStaff(
  context: DatabaseContext,
  businessId: string,
  productId: string,
  variantId: string | null,
  staffId: string | null,
): Promise<ServiceStaff[]> {
  const result = await sql<ServiceStaff>`
    select sp."id" as "staffId", sp."displayName" as "staffName",
           (array_agg(ss."durationOverrideMinutes"
                      order by (ss."variantId" is not null) desc))[1] as "durationOverrideMinutes"
    from app.staff_profiles sp
    join app.staff_services ss on ss."staffId" = sp."id" and ss."businessId" = sp."businessId"
    where sp."businessId" = ${businessId}::uuid
      and sp."isBookable"
      and ss."productId" = ${productId}::uuid
      and (${variantId}::uuid is null or ss."variantId" is null or ss."variantId" = ${variantId}::uuid)
      and (${staffId}::uuid is null or sp."id" = ${staffId}::uuid)
    group by sp."id", sp."displayName"
    order by sp."displayName"
  `.execute(context.transaction);
  return result.rows;
}

export async function scheduleEntries(
  context: DatabaseContext,
  businessId: string,
  staffIds: string[],
  locationId: string | null,
): Promise<ScheduleEntry[]> {
  if (staffIds.length === 0) return [];
  const result = await sql<ScheduleEntry>`
    select sc."staffId", sc."locationId", loc."timezone", sc."weekday",
           sc."startTime", sc."endTime"
    from app.staff_schedules sc
    join app.locations loc on loc."id" = sc."locationId"
    where sc."businessId" = ${businessId}::uuid
      and sc."staffId" = any(${staffIds}::uuid[])
      and (${locationId}::uuid is null or sc."locationId" = ${locationId}::uuid)
  `.execute(context.transaction);
  return result.rows;
}

export async function exceptionEntries(
  context: DatabaseContext,
  businessId: string,
  staffIds: string[],
  fromMs: number,
  toMs: number,
): Promise<ExceptionEntry[]> {
  const result = await sql<ExceptionEntry>`
    select ex."staffId", ex."locationId", loc."timezone", ex."kind",
           ex."startsAt", ex."endsAt"
    from app.schedule_exceptions ex
    left join app.locations loc on loc."id" = ex."locationId"
    where ex."businessId" = ${businessId}::uuid
      and ex."startsAt" < ${new Date(toMs)}::timestamptz
      and ex."endsAt" > ${new Date(fromMs)}::timestamptz
      and (ex."staffId" is null or ex."staffId" = any(${staffIds}::uuid[]))
  `.execute(context.transaction);
  return result.rows;
}

export async function occupiedRanges(
  context: DatabaseContext,
  businessId: string,
  staffIds: string[],
  fromMs: number,
  toMs: number,
  excludeBookingId: string | null,
): Promise<OccupiedRange[]> {
  if (staffIds.length === 0) return [];
  const activeStatuses = ACTIVE_BOOKING_STATUSES.map((status) => sql`${status}`);
  const result = await sql<OccupiedRange>`
    select o."staffId",
           (o."startsAt" - coalesce(pss."bufferBeforeMinutes", 0) * interval '1 minute') as "paddedStartsAt",
           (o."endsAt" + coalesce(pss."bufferAfterMinutes", 0) * interval '1 minute') as "paddedEndsAt"
    from app.booking_items o
    left join app.product_service_settings pss on pss."productId" = o."productId"
    where o."businessId" = ${businessId}::uuid
      and o."status" in (${sql.join(activeStatuses, sql`, `)})
      and o."staffId" = any(${staffIds}::uuid[])
      and o."startsAt" < ${new Date(toMs)}::timestamptz
      and o."endsAt" > ${new Date(fromMs)}::timestamptz
      and (${excludeBookingId}::uuid is null or o."bookingId" <> ${excludeBookingId}::uuid)
  `.execute(context.transaction);
  return result.rows;
}

interface SlotInput {
  readonly fromDate: string;
  readonly dayCount: number;
  readonly settings: SlotSettings;
  readonly staff: ServiceStaff[];
  readonly schedules: ScheduleEntry[];
  readonly exceptions: ExceptionEntry[];
  readonly occupied: OccupiedRange[];
  readonly locationFilter: string | null;
  readonly staffFilter: string | null;
  readonly nowMilliseconds: number;
  /** Extra time from chosen add-ons (modifier options). */
  readonly extraMinutes?: number;
  /** Branches where the service is switched off in product location settings. */
  readonly unavailableLocationIds?: readonly string[];
}

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly locationId: string;
  readonly timezone: string;
}

/**
 * Generate booking.slots.ts: per staff member, per calendar day, the weekly
 * schedule minus time off (and any 'extra' shifts) is divided on the product's
 * slot-interval, and any candidate whose padded window overlaps an active
 * booking for that staff is dropped. minNotice/maxAdvance come from the product.
 */
export function computeSlots(input: SlotInput): AvailableSlot[] {
  const { settings } = input;
  const candidateBeforeMs = settings.bufferBeforeMinutes * 60 * 1000;
  const candidateAfterMs = settings.bufferAfterMinutes * 60 * 1000;
  const slotIntervalMs = settings.slotIntervalMinutes * 60 * 1000;
  const minNoticeMs = settings.minNoticeMinutes * 60 * 1000;
  const maxAdvanceMs = settings.maxAdvanceDays * MILLISECONDS_PER_DAY;

  const occupiedByStaff = new Map<string, OccupiedRange[]>();
  for (const range of input.occupied) {
    const list = occupiedByStaff.get(range.staffId) ?? [];
    list.push(range);
    occupiedByStaff.set(range.staffId, list);
  }

  const slots: AvailableSlot[] = [];
  for (const staff of input.staff) {
    if (input.staffFilter && staff.staffId !== input.staffFilter) continue;
    const occupied = occupiedByStaff.get(staff.staffId) ?? [];
    const durationMinutes = (staff.durationOverrideMinutes ?? settings.durationMinutes) + (input.extraMinutes ?? 0);
    const durationMs = durationMinutes * 60 * 1000;
    for (const day of calendarDays(input.fromDate, input.dayCount)) {
      for (const interval of workingIntervals(input, staff.staffId, day)) {
        if (interval.end - interval.start < durationMs) continue;
        let candidate = interval.start;
        while (candidate + durationMs <= interval.end) {
          const paddedStart = candidate - candidateBeforeMs;
          const paddedEnd = candidate + durationMs + candidateAfterMs;
          if (
            candidate >= input.nowMilliseconds + minNoticeMs &&
            candidate <= input.nowMilliseconds + maxAdvanceMs &&
            !paddedOverlap(occupied, paddedStart, paddedEnd)
          ) {
            slots.push(buildSlot(staff, interval, day, candidate, candidate + durationMs));
          }
          candidate += slotIntervalMs;
        }
      }
    }
  }
  return slots;
}

function paddedOverlap(occupied: OccupiedRange[], start: number, end: number): boolean {
  return occupied.some(
    (range) => start < range.paddedEndsAt.getTime() && range.paddedStartsAt.getTime() < end,
  );
}

function buildSlot(
  staff: ServiceStaff,
  interval: Interval,
  day: string,
  startsAtMs: number,
  endsAtMs: number,
): AvailableSlot {
  const start = utcToLocalDateTime(startsAtMs, interval.timezone);
  const end = utcToLocalDateTime(endsAtMs, interval.timezone);
  return {
    staff_id: staff.staffId,
    staff_name: staff.staffName,
    location_id: interval.locationId,
    date: day,
    start_time: start.time,
    end_time: end.time,
    starts_at: new Date(startsAtMs).toISOString(),
    ends_at: new Date(endsAtMs).toISOString(),
  };
}

function calendarDays(fromDate: string, count: number): string[] {
  const [year, month, day] = fromDate.split("-").map(Number) as [number, number, number];
  const start = Date.UTC(year, month - 1, day);
  return Array.from({ length: count }, (_, index) =>
    new Date(start + index * MILLISECONDS_PER_DAY).toISOString().slice(0, 10),
  );
}

/**
 * A staff member's working intervals for one calendar day, in UTC: weekly
 * schedule entries for that weekday plus extra shifts, minus time-off overlaps.
 * Extra shifts only produce slots when they name a location (a shift needs a
 * place); a location-less time-off exception applies business-wide.
 */
function workingIntervals(input: SlotInput, staffId: string, day: string): Interval[] {
  const intervals: Interval[] = [];

  for (const schedule of input.schedules) {
    if (schedule.staffId !== staffId || schedule.weekday !== localDateWeekday(day)) continue;
    if (input.locationFilter && schedule.locationId !== input.locationFilter) continue;
    if (input.unavailableLocationIds?.includes(schedule.locationId)) continue;
    intervals.push({
      start: localDateTimeToUtcMilliseconds(day, schedule.startTime, schedule.timezone),
      end: localDateTimeToUtcMilliseconds(day, schedule.endTime, schedule.timezone),
      locationId: schedule.locationId,
      timezone: schedule.timezone,
    });
  }

  for (const exception of input.exceptions) {
    if (exception.kind !== "extra") continue;
    if (exception.staffId !== null && exception.staffId !== staffId) continue;
    if (exception.locationId === null) continue;
    if (input.locationFilter && exception.locationId !== input.locationFilter) continue;
    if (input.unavailableLocationIds?.includes(exception.locationId)) continue;
    const timezone = exception.timezone ?? "UTC";
    const boundaries = localDayBoundaries(day, timezone);
    const start = Math.max(exception.startsAt.getTime(), boundaries.start);
    const end = Math.min(exception.endsAt.getTime(), boundaries.end);
    if (start < end) {
      intervals.push({ start, end, locationId: exception.locationId, timezone });
    }
  }

  for (const exception of input.exceptions) {
    if (exception.kind !== "off") continue;
    if (exception.staffId !== null && exception.staffId !== staffId) continue;
    subtractOff(intervals, exception.startsAt.getTime(), exception.endsAt.getTime(), exception.locationId);
  }

  return mergeIntervals(intervals);
}

/** Remove [cutStart, cutEnd] from every interval (optionally only one location). */
function subtractOff(
  intervals: Interval[],
  cutStart: number,
  cutEnd: number,
  onlyLocation: string | null,
): void {
  for (let index = intervals.length - 1; index >= 0; index -= 1) {
    const interval = intervals[index];
    if (!interval) continue;
    if (onlyLocation !== null && interval.locationId !== onlyLocation) continue;
    if (cutEnd <= interval.start || cutStart >= interval.end) continue;
    const pieces: Interval[] = [];
    if (cutStart > interval.start) {
      pieces.push({ ...interval, start: interval.start, end: cutStart });
    }
    if (cutEnd < interval.end) {
      pieces.push({ ...interval, start: cutEnd, end: interval.end });
    }
    intervals.splice(index, 1, ...pieces);
  }
}

/** Sort by start and merge overlapping or touching intervals. */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && last.locationId === interval.locationId && interval.start <= last.end) {
      merged[merged.length - 1] = {
        ...last,
        end: Math.max(last.end, interval.end),
      };
    } else {
      merged.push(interval);
    }
  }
  return merged;
}

function localDayBoundaries(day: string, timezone: string): { start: number; end: number } {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(year, month - 1, date) + MILLISECONDS_PER_DAY).toISOString().slice(0, 10);
  return {
    start: localDateTimeToUtcMilliseconds(day, "00:00", timezone),
    end: localDateTimeToUtcMilliseconds(next, "00:00", timezone),
  };
}

/** Branches where this service has been switched off. */
export async function unavailableLocations(
  context: DatabaseContext,
  businessId: string,
  productId: string,
): Promise<string[]> {
  const result = await sql<{ locationId: string }>`
    select pls."locationId"
    from app.product_location_settings pls
    where pls."businessId" = ${businessId}::uuid
      and pls."productId" = ${productId}::uuid
      and not pls."isAvailable"
  `.execute(context.transaction);
  return result.rows.map((row) => row.locationId);
}

/** Total extra minutes the chosen add-ons add to a service. */
export async function modifierExtraMinutes(
  context: DatabaseContext,
  businessId: string,
  optionIds: readonly string[],
): Promise<number> {
  if (optionIds.length === 0) return 0;
  const result = await sql<{ total: number | null }>`
    select sum(mo."extraDurationMinutes")::int as "total"
    from app.modifier_options mo
    where mo."businessId" = ${businessId}::uuid
      and mo."id" = any(${[...optionIds]}::uuid[])
  `.execute(context.transaction);
  return result.rows[0]?.total ?? 0;
}
