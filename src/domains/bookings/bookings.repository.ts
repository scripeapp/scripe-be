import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { BookingItemRow, BookingRow, BookingStatus } from "./bookings.types.js";

// The destination timezone comes from the location the visit happens at, falling
// back to the store — the frontend renders booking_date/start_time in it.
const STORE_TIMEZONE = sql`
  coalesce((select loc."timezone" from app.locations loc where loc."id" = bookings."locationId"),
           store."timezone")
`;

const BOOKING_COLUMNS = sql`
  bookings."id", bookings."businessId", bookings."storeId", bookings."locationId",
  bookings."orderId", bookings."customerName", bookings."customerEmail", bookings."customerPhone",
  bookings."status", bookings."source", bookings."startsAt", bookings."endsAt",
  bookings."holdExpiresAt", bookings."manageToken", bookings."notes", bookings."cancelledReason",
  bookings."requiresApproval", bookings."initiatedBy", bookings."createdAt", bookings."updatedAt"
`;

function selectBookings() {
  return sql`
    select ${BOOKING_COLUMNS},
           ${STORE_TIMEZONE}::text as "timezone"
    from app.bookings
    join app.stores store on store."id" = bookings."storeId"
  `;
}

export interface BookingListFilters {
  readonly orderId?: string;
  readonly productId?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
  readonly status?: BookingStatus;
}

export async function listBookings(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  filters: BookingListFilters,
  limit: number,
  offset: number,
): Promise<BookingRow[]> {
  const clauses: RawBuilder<unknown>[] = [
    sql`bookings."businessId" = ${businessId}::uuid`,
    sql`bookings."storeId" = ${storeId}::uuid`,
  ];
  if (filters.orderId) clauses.push(sql`bookings."orderId" = ${filters.orderId}::uuid`);
  if (filters.productId) {
    clauses.push(
      sql`exists (select 1 from app.booking_items bi where bi."bookingId" = bookings."id" and bi."productId" = ${filters.productId}::uuid)`,
    );
  }
  if (filters.dateFrom) clauses.push(sql`bookings."startsAt" >= ${filters.dateFrom}::date`);
  if (filters.dateTo) clauses.push(sql`bookings."startsAt" < ${filters.dateTo}::date + interval '1 day'`);
  if (filters.status) clauses.push(sql`bookings."status" = ${filters.status}`);

  const result = await sql<BookingRow>`
    ${selectBookings()}
    where ${sql.join(clauses, sql` and `)}
    order by bookings."startsAt" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);
  const rows = result.rows;
  if (rows.length === 0) return [];
  await attachItems(context, businessId, rows);
  return rows;
}

export async function findById(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
): Promise<BookingRow | undefined> {
  const result = await sql<BookingRow>`
    ${selectBookings()}
    where bookings."id" = ${bookingId}::uuid and bookings."businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  const row = result.rows[0];
  if (!row) return undefined;
  await attachItems(context, businessId, [row]);
  return row;
}

async function attachItems(context: DatabaseContext, businessId: string, rows: BookingRow[]): Promise<void> {
  const bookingIds = rows.map((row) => row.id);
  const result = await sql<BookingItemRow>`
    select i."id", i."businessId", i."bookingId", i."position", i."productId", i."variantId",
           i."staffId", sp."displayName" as "staffName", i."startsAt", i."endsAt",
           i."modifierOptionIds", i."priceMinor", i."durationMinutes", i."status"
    from app.booking_items i
    left join app.staff_profiles sp on sp."id" = i."staffId"
    where i."businessId" = ${businessId}::uuid
      and i."bookingId" = any(${bookingIds}::uuid[])
    order by i."bookingId", i."position"
  `.execute(context.transaction);
  const byBooking = new Map<string, BookingItemRow[]>();
  for (const item of result.rows) {
    const items = byBooking.get(item.bookingId) ?? [];
    items.push(item);
    byBooking.set(item.bookingId, items);
  }
  for (const row of rows) row.items = byBooking.get(row.id) ?? [];
}

export interface ReserveResult {
  readonly id: string | null;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
  readonly holdExpiresAt: Date | null;
  readonly error: string | null;
}

/** Public storefront hold, executed as the trusted SECURITY DEFINER function. */
export async function reserveFromPublic(
  context: DatabaseContext,
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
): Promise<ReserveResult> {
  const result = await sql<ReserveResult>`
    select * from app.reserve_booking_from_public(
      ${input.storeId}::uuid, ${input.productId}::uuid,
      ${input.variantId}::uuid, ${input.staffId}::uuid, ${input.locationId}::uuid,
      ${input.startsAt}::timestamptz, ${input.customerName ?? null}, ${input.customerEmail ?? null},
      ${input.customerPhone ?? null}, ${input.manageToken ?? null}, ${input.holdMinutes ?? 10}
    )
  `.execute(context.transaction);
  const row = result.rows[0];
  return {
    id: row?.id ?? null,
    startsAt: row?.startsAt ?? null,
    endsAt: row?.endsAt ?? null,
    holdExpiresAt: row?.holdExpiresAt ?? null,
    error: row?.error ?? null,
  };
}

export function businessIdForActiveStore(
  context: DatabaseContext,
  storeId: string,
): Promise<string | undefined> {
  return storeBusinessId(context, sql`store."status" = 'active' and store."id" = ${storeId}::uuid`);
}

export function businessIdForStore(context: DatabaseContext, storeId: string): Promise<string | undefined> {
  return storeBusinessId(context, sql`store."id" = ${storeId}::uuid`);
}

function storeBusinessId(
  context: DatabaseContext,
  predicate: RawBuilder<unknown>,
): Promise<string | undefined> {
  return sql<{ businessId: string }>`
    select "businessId" from app.stores store where ${predicate} limit 1
  `.execute(context.transaction).then((result) => result.rows[0]?.businessId);
}

export function storeTimezone(context: DatabaseContext, storeId: string): Promise<string | undefined> {
  return sql<{ timezone: string }>`
    select "timezone" from app.stores where "id" = ${storeId}::uuid limit 1
  `.execute(context.transaction).then((result) => result.rows[0]?.timezone);
}

export interface ShiftedItemInput {
  readonly id: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

/**
 * Move a booking's items to new UTC windows. The exclusion constraint validates
 * the new windows inside the caller's transaction; a violation surfaces as a
 * DatabaseError with kind "exclusion-violation".
 */
export async function shiftItems(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
  shifts: ShiftedItemInput[],
): Promise<void> {
  for (const shift of shifts) {
    await sql`
      update app.booking_items
        set "startsAt" = ${shift.startsAt}::timestamptz,
            "endsAt" = ${shift.endsAt}::timestamptz,
            "updatedAt" = now()
      where "id" = ${shift.id}::uuid
        and "bookingId" = ${bookingId}::uuid
        and "businessId" = ${businessId}::uuid
    `.execute(context.transaction);
  }
}

export interface StatusPatch {
  readonly status: BookingStatus;
  readonly cancelReason?: string | null;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
}

export async function updateBookingStatus(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  bookingId: string,
  patch: StatusPatch,
): Promise<BookingRow | undefined> {
  const fields: RawBuilder<unknown>[] = [sql`"status" = ${patch.status}`, sql`"updatedAt" = now()`];
  // Free a slot, un-hold a checkout, or hard-cancel: the hold is irrelevant once
  // the booking leaves the held state.
  if (patch.status !== "held") fields.push(sql`"holdExpiresAt" = null`);
  if (patch.cancelReason !== undefined) fields.push(sql`"cancelledReason" = ${patch.cancelReason}`);
  if (patch.startsAt !== undefined) fields.push(sql`"startsAt" = ${patch.startsAt}::timestamptz`);
  if (patch.endsAt !== undefined) fields.push(sql`"endsAt" = ${patch.endsAt}::timestamptz`);

  await sql`
    update app.bookings set ${sql.join(fields, sql`, `)}
    where "id" = ${bookingId}::uuid
      and "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
  `.execute(context.transaction);
  return findById(context, businessId, bookingId);
}

export interface ServiceStaffCheck {
  readonly baseDuration: number | null;
  readonly durationOverride: number | null;
  readonly performs: boolean;
  readonly bookable: boolean;
}

/** Whether a staff member can perform a service, and how long it takes them. */
export async function serviceStaffCheck(
  context: DatabaseContext,
  businessId: string,
  productId: string,
  variantId: string | null,
  staffId: string,
): Promise<ServiceStaffCheck | undefined> {
  const result = await sql<ServiceStaffCheck>`
    select pss."durationMinutes" as "baseDuration",
           (select ss."durationOverrideMinutes" from app.staff_services ss
             where ss."businessId" = p."businessId" and ss."staffId" = ${staffId}::uuid
               and ss."productId" = p."id"
               and (${variantId}::uuid is null or ss."variantId" is null or ss."variantId" = ${variantId}::uuid)
             order by (ss."variantId" is not null) desc
             limit 1) as "durationOverride",
           exists (select 1 from app.staff_services ss
             where ss."businessId" = p."businessId" and ss."staffId" = ${staffId}::uuid
               and ss."productId" = p."id"
               and (${variantId}::uuid is null or ss."variantId" is null or ss."variantId" = ${variantId}::uuid)) as "performs",
           exists (select 1 from app.staff_profiles sp
             where sp."businessId" = p."businessId" and sp."id" = ${staffId}::uuid and sp."isBookable") as "bookable"
    from app.products p
    left join app.product_service_settings pss on pss."productId" = p."id"
    where p."id" = ${productId}::uuid
      and p."businessId" = ${businessId}::uuid
      and p."productType" = 'service'
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

/** A location of this store, or the store's default branch when none is given. */
export async function resolveStoreLocation(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  locationId: string | null,
): Promise<string | undefined> {
  const result = await sql<{ id: string }>`
    select loc."id" from app.locations loc
    where loc."businessId" = ${businessId}::uuid
      and loc."storeId" = ${storeId}::uuid
      and (${locationId}::uuid is null and loc."isDefault" or loc."id" = ${locationId}::uuid)
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.id;
}

export interface NewBookingItem {
  readonly productId: string;
  readonly variantId: string | null;
  readonly staffId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly durationMinutes: number;
  readonly modifierOptionIds: readonly string[];
}

/** A booking made by the business itself: confirmed straight away, no hold. */
export async function insertStaffBooking(
  context: DatabaseContext,
  input: {
    businessId: string;
    storeId: string;
    locationId: string;
    source: "dashboard" | "walk_in" | "pos";
    customerName: string | null;
    customerEmail: string | null;
    customerPhone: string | null;
    notes: string | null;
    manageToken: string;
    items: readonly NewBookingItem[];
  },
): Promise<string> {
  const first = input.items[0]!;
  const last = input.items[input.items.length - 1]!;
  const booking = await sql<{ id: string }>`
    insert into app.bookings (
      "businessId", "storeId", "locationId", "customerName", "customerEmail", "customerPhone",
      "status", "source", "startsAt", "endsAt", "manageToken", "notes", "initiatedBy"
    ) values (
      ${input.businessId}::uuid, ${input.storeId}::uuid, ${input.locationId}::uuid,
      ${input.customerName}, ${input.customerEmail}, ${input.customerPhone},
      'confirmed', ${input.source}, ${first.startsAt}::timestamptz, ${last.endsAt}::timestamptz,
      ${input.manageToken}, ${input.notes}, 'creator'
    )
    returning "id"
  `.execute(context.transaction);
  const bookingId = booking.rows[0]!.id;
  for (const [position, item] of input.items.entries()) {
    await sql`
      insert into app.booking_items (
        "businessId", "bookingId", "position", "productId", "variantId", "staffId",
        "startsAt", "endsAt", "modifierOptionIds", "priceMinor", "durationMinutes", "status"
      ) values (
        ${input.businessId}::uuid, ${bookingId}::uuid, ${position}, ${item.productId}::uuid,
        ${item.variantId}::uuid, ${item.staffId}::uuid, ${item.startsAt}::timestamptz,
        ${item.endsAt}::timestamptz, ${[...item.modifierOptionIds]}::uuid[], 0,
        ${item.durationMinutes}, 'confirmed'
      )
    `.execute(context.transaction);
  }
  return bookingId;
}
