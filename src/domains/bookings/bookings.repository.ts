import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { BookingRow } from "./bookings.types.js";

// Dates are cast to text so a plain calendar date never shifts a day through
// JS Date/UTC conversion on the way out.
const BOOKING_COLUMNS = sql`
  "id", "businessId", "storeId", "productId", "orderId", "customerPartyId",
  "customerName", "customerEmail", "customerPhone",
  to_char("bookingDate", 'YYYY-MM-DD') as "bookingDate", "startTime",
  "endTime", "timezone", "locationType", "locationDetails", "requiresApproval",
  "durationMinutes", "status", "declineReason",
  to_char("rescheduledFrom", 'YYYY-MM-DD') as "rescheduledFrom", "initiatedBy",
  "expiresAt", "createdAt", "updatedAt"
`;

/**
 * Public storefront reservation. Derives businessId from the active store in a
 * single INSERT...SELECT (the stores_public_read policy allows reading an active
 * store), so an unauthenticated shopper can hold a slot. Returns undefined when
 * the store is missing or not active.
 */
export async function reserveBooking(
  context: DatabaseContext,
  input: { storeId: string; productId: string; date: string; startTime: string; endTime: string; expiresInMinutes: number },
): Promise<{ id: string; expiresAt: Date } | undefined> {
  const result = await sql<{ id: string; expiresAt: Date }>`
    insert into app.bookings
      ("businessId", "storeId", "productId", "bookingDate", "startTime", "endTime",
       "status", "initiatedBy", "expiresAt")
    select s."businessId", s."id", ${input.productId}::uuid,
      ${input.date}::date, ${input.startTime}, ${input.endTime},
      'pending', 'customer', now() + (${input.expiresInMinutes} * interval '1 minute')
    from app.stores s
    where s."id" = ${input.storeId}::uuid and s."status" = 'active'
    returning "id", "expiresAt"
  `.execute(context.transaction);
  return result.rows[0];
}

/**
 * Resolve the owning business from an active store (stores_public_read allows
 * this without a member identity). Lets the flat `/store/bookings` endpoints
 * work off store_id alone, since the frontend doesn't send business_id on them.
 */
export async function businessIdForActiveStore(
  context: DatabaseContext,
  storeId: string,
): Promise<string | undefined> {
  const result = await sql<{ businessId: string }>`
    select "businessId" from app.stores
    where "id" = ${storeId}::uuid and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.businessId;
}

/**
 * Resolve the owning business from a store the CALLER can read (stores_read =
 * has_business_permission('store.read')). Used by the authenticated dashboard
 * endpoints, which must work on draft/unpublished stores too.
 */
export async function businessIdForStore(
  context: DatabaseContext,
  storeId: string,
): Promise<string | undefined> {
  const result = await sql<{ businessId: string }>`
    select "businessId" from app.stores where "id" = ${storeId}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0]?.businessId;
}

export async function listByProduct(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  productId: string,
  page: number,
  limit: number,
): Promise<BookingRow[]> {
  const offset = (page - 1) * limit;
  const result = await sql<BookingRow>`
    select ${BOOKING_COLUMNS} from app.bookings
    where "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
      and "productId" = ${productId}::uuid
    order by "bookingDate" desc, "startTime" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);
  return result.rows;
}

export async function listByOrder(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  orderId: string,
): Promise<BookingRow[]> {
  const result = await sql<BookingRow>`
    select ${BOOKING_COLUMNS} from app.bookings
    where "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
      and "orderId" = ${orderId}::uuid
    order by "bookingDate" desc, "startTime" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findById(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
): Promise<BookingRow | undefined> {
  const result = await sql<BookingRow>`
    select ${BOOKING_COLUMNS} from app.bookings
    where "id" = ${bookingId}::uuid and "businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function updateStatus(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  bookingId: string,
  patch: {
    status: string;
    declineReason?: string | null;
    bookingDate?: string;
    startTime?: string;
    endTime?: string;
    rescheduledFrom?: string;
  },
): Promise<BookingRow | undefined> {
  const fields: RawBuilder<unknown>[] = [sql`"status" = ${patch.status}`, sql`"updatedAt" = now()`];
  if (patch.declineReason !== undefined) fields.push(sql`"declineReason" = ${patch.declineReason}`);
  if (patch.bookingDate !== undefined) fields.push(sql`"bookingDate" = ${patch.bookingDate}::date`);
  if (patch.startTime !== undefined) fields.push(sql`"startTime" = ${patch.startTime}`);
  if (patch.endTime !== undefined) fields.push(sql`"endTime" = ${patch.endTime}`);
  if (patch.rescheduledFrom !== undefined) fields.push(sql`"rescheduledFrom" = ${patch.rescheduledFrom}::date`);

  const result = await sql<BookingRow>`
    update app.bookings set ${sql.join(fields, sql`, `)}
    where "id" = ${bookingId}::uuid
      and "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
    returning ${BOOKING_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}
