/**
 * Keeps bookings on the booked person's Google Calendar (Settings ›
 * Integrations). Each booked service becomes one event on the calendar of the
 * staff member performing it (the business owner's when that staff member has
 * no login), with the customer invited and, when the person wants it, a
 * Google Meet link. Best effort: a Google failure is logged and never undoes
 * the booking.
 */
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { anonymousPrincipal } from "../../db/principal.js";
import {
  busyIntervals,
  createCalendarEvent,
  deleteCalendarEvent,
  findGoogleCalendarAccount,
  moveCalendarEvent,
} from "../../integrations/google-calendar.js";
import type { BookingStatus } from "./bookings.types.js";
import type { OccupiedRange } from "./slots.js";

/** Statuses whose service belongs on the calendar; a no-show keeps its event because the time was really held. */
const ON_CALENDAR: readonly BookingStatus[] = ["confirmed", "arrived", "in_service", "completed", "no_show"];

interface CalendarTarget {
  readonly bookingItemId: string;
  readonly businessId: string;
  readonly userId: string;
  readonly itemStatus: BookingStatus;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly serviceName: string;
  readonly staffName: string | null;
  readonly businessName: string;
  readonly locationName: string | null;
  readonly timezone: string;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly meetEnabled: boolean;
  readonly googleEventId: string | null;
  readonly eventUserId: string | null;
}

function asSystem<T>(database: Database, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
  return withDatabaseContext(database, anonymousPrincipal(randomUUID()), work);
}

function describe(target: CalendarTarget): string {
  return [
    `Booked with ${target.businessName}.`,
    target.customerName ? `Customer: ${target.customerName}` : null,
    target.staffName ? `With: ${target.staffName}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

async function forgetEvent(database: Database, bookingItemId: string): Promise<void> {
  await asSystem(database, (context) => sql`select app.forget_booking_calendar_event(${bookingItemId}::uuid)`.execute(context.transaction));
}

async function removeEvent(database: Database, target: CalendarTarget): Promise<void> {
  const owner = target.eventUserId!;
  const account = await findGoogleCalendarAccount(owner);
  if (account) await deleteCalendarEvent(owner, account, target.googleEventId!);
  await forgetEvent(database, target.bookingItemId);
}

async function addEvent(database: Database, target: CalendarTarget): Promise<void> {
  const account = await findGoogleCalendarAccount(target.userId);
  if (!account) return;
  const created = await createCalendarEvent(target.userId, account, {
    requestId: target.bookingItemId,
    summary: `${target.serviceName} · ${target.businessName}`,
    description: describe(target),
    location: target.locationName,
    startsAt: target.startsAt,
    endsAt: target.endsAt,
    timezone: target.timezone,
    attendeeEmail: target.customerEmail,
    withMeet: target.meetEnabled,
  });
  await asSystem(database, (context) =>
    sql`select app.record_booking_calendar_event(${target.bookingItemId}::uuid, ${target.businessId}::uuid, ${target.userId}::uuid, ${created.eventId}, ${created.meetUrl})`.execute(
      context.transaction,
    ),
  );
}

async function syncTarget(database: Database, target: CalendarTarget, rescheduled: boolean): Promise<void> {
  const belongsOnCalendar = ON_CALENDAR.includes(target.itemStatus);
  if (target.googleEventId) {
    // Off the calendar now, or reassigned to someone else: remove the old event first.
    if (!belongsOnCalendar || target.eventUserId !== target.userId) await removeEvent(database, target);
    else if (rescheduled) {
      const account = await findGoogleCalendarAccount(target.userId);
      if (account) await moveCalendarEvent(target.userId, account, target.googleEventId, target);
      return;
    } else return;
  }
  if (belongsOnCalendar) await addEvent(database, target);
}

/**
 * Brings a booking's Google Calendar events in line with the booking. Call it
 * after the booking is committed; pass rescheduled when its times moved so
 * existing events (and the customer's invite) are updated.
 */
export async function syncBookingCalendars(database: Database, bookingId: string, options: { rescheduled?: boolean } = {}): Promise<void> {
  try {
    const targets = await asSystem(database, async (context) =>
      (await sql<CalendarTarget>`select * from app.booking_calendar_targets(${bookingId}::uuid)`.execute(context.transaction)).rows,
    );
    for (const target of targets) {
      try {
        await syncTarget(database, target, options.rescheduled ?? false);
      } catch (error) {
        console.warn(`[calendar] sync failed for booking item ${target.bookingItemId}:`, error);
      }
    }
  } catch (error) {
    console.warn(`[calendar] could not load calendar targets for booking ${bookingId}:`, error);
  }
}

/**
 * Busy blocks from the staff members' own Google Calendars, as occupied
 * ranges for the slot finder. A calendar that can't be read is skipped rather
 * than blocking every slot.
 */
export async function calendarOccupiedRanges(
  context: DatabaseContext,
  businessId: string,
  staffIds: readonly string[],
  fromMs: number,
  toMs: number,
): Promise<OccupiedRange[]> {
  if (staffIds.length === 0) return [];
  const links = (
    await sql<{ staffId: string; userId: string }>`select * from app.staff_calendar_users(${businessId}::uuid, ${[...staffIds]}::uuid[])`.execute(
      context.transaction,
    )
  ).rows;
  const ranges = await Promise.all(
    links.map(async ({ staffId, userId }) => {
      try {
        const account = await findGoogleCalendarAccount(userId);
        if (!account) return [];
        const busy = await busyIntervals(userId, account, new Date(fromMs), new Date(toMs));
        return busy.map((block) => ({ staffId, paddedStartsAt: block.start, paddedEndsAt: block.end }));
      } catch (error) {
        console.warn(`[calendar] could not read busy times for staff ${staffId}:`, error);
        return [];
      }
    }),
  );
  return ranges.flat();
}
