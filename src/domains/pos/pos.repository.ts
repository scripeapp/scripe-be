import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { conflictError, notFoundError } from "../../shared/errors.js";
import type { PosLineInput, PricedPosLine } from "./pos.types.js";
import type { BookingItemRow, BookingRow } from "../bookings/bookings.types.js";

export interface LocationPricingRow {
  readonly id: string;
  readonly timezone: string;
  readonly taxRate: number;
  readonly serviceChargeRates: Record<string, number>;
}

export function businessIdForStore(context: DatabaseContext, storeId: string): Promise<string | undefined> {
  return sql<{ businessId: string }>`
    select "businessId" from app.stores where "id" = ${storeId}::uuid limit 1
  `.execute(context.transaction).then((result) => result.rows[0]?.businessId);
}

export async function businessCurrency(context: DatabaseContext, businessId: string): Promise<string> {
  const result = await sql<{ currency: string | null }>`
    select "defaultCurrency" as "currency" from app.businesses where "id" = ${businessId}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0]?.currency ?? "NGN";
}

export async function locationPricing(
  context: DatabaseContext,
  businessId: string,
  locationId: string,
): Promise<LocationPricingRow | undefined> {
  const result = await sql<LocationPricingRow>`
    select "id", "timezone", "taxRate"::float8 as "taxRate", "serviceChargeRates"
    from app.locations
    where "id" = ${locationId}::uuid and "businessId" = ${businessId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export interface VariantPriceRow {
  readonly productVariantId: string;
  readonly productId: string;
  readonly description: string;
  readonly sku: string | null;
  readonly unitMinor: string;
}

/**
 * The active price for a variant at a point in time, preferring any
 * location-specific override over the store-wide price — the same rule the
 * order/cart flow applies. Throws when no active price exists so the price
 * can never silently become zero at the till.
 */
export async function resolveVariantPrice(
  context: DatabaseContext,
  businessId: string,
  productVariantId: string,
  locationId: string | null,
  assetCode: string,
): Promise<VariantPriceRow> {
  const locationClause = locationId
    ? sql`and (pp."locationId" is null or pp."locationId" = ${locationId}::uuid)`
    : sql`and pp."locationId" is null`;
  const result = await sql<VariantPriceRow>`
    select v."id" as "productVariantId", p."id" as "productId", p."name" as "description", v."sku",
           (select pp."amountMinor"::text
            from app.product_prices pp
            where pp."businessId" = ${businessId}::uuid
              and pp."productVariantId" = v."id"
              and pp."assetCode" = ${assetCode}
              and pp."status" = 'active'
              and pp."effectiveFrom" <= now()
              and (pp."effectiveTo" is null or pp."effectiveTo" > now())
              ${locationClause}
            order by (pp."locationId" is not null) desc, pp."effectiveFrom" desc
            limit 1) as "unitMinor"
    from app.product_variants v
    join app.products p on p."id" = v."productId" and p."businessId" = v."businessId"
    where v."id" = ${productVariantId}::uuid
      and v."businessId" = ${businessId}::uuid
      and v."status" = 'active'
  `.execute(context.transaction);
  const row = result.rows[0];
  if (!row?.unitMinor) throw conflictError(`No active price for variant ${productVariantId}`);
  return row;
}

/** Resolves the variant a ticket line refers to (product-level lines use the default variant). */
export async function defaultVariantId(
  context: DatabaseContext,
  businessId: string,
  productId: string,
): Promise<string | undefined> {
  const result = await sql<{ id: string }>`
    select "id" from app.product_variants
    where "businessId" = ${businessId}::uuid and "productId" = ${productId}::uuid and "status" = 'active'
    order by ("isDefault") desc, "createdAt"
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.id;
}

/** Sums the price adjustments of the selected modifier options for one line. */
export async function modifierAdjustmentMinor(
  context: DatabaseContext,
  businessId: string,
  optionIds: string[],
): Promise<bigint> {
  if (optionIds.length === 0) return 0n;
  const result = await sql<{ total: string | null }>`
    select sum("priceAdjustmentMinor")::text as "total"
    from app.modifier_options
    where "businessId" = ${businessId}::uuid
      and "id" = any(${optionIds}::uuid[])
      and "isAvailable"
  `.execute(context.transaction);
  return BigInt(result.rows[0]?.total ?? "0");
}

export async function ensurePosChannel(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<string> {
  const existing = await sql<{ id: string }>`
    select "id" from app.sales_channels
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "code" = 'pos'
    limit 1
  `.execute(context.transaction);
  if (existing.rows[0]?.id) return existing.rows[0].id;

  const created = await sql<{ id: string }>`
    insert into app.sales_channels ("businessId", "storeId", "code", "name", "kind")
    values (${businessId}::uuid, ${storeId}::uuid, 'pos', 'Point of Sale', 'pos')
    returning "id"
  `.execute(context.transaction);
  if (!created.rows[0]) throw conflictError("Could not create the Point of Sale channel");
  return created.rows[0].id;
}

export interface TillCurrencyRow {
  readonly currency: string;
  readonly locationId: string | null;
}

export async function storeCurrency(context: DatabaseContext, businessId: string, storeId: string): Promise<string> {
  return businessCurrency(context, businessId);
}

export async function validateOpenShift(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
  locationId: string,
  shiftId: string,
): Promise<void> {
  const result = await sql<{ id: string }>`
    select "id" from app.register_shifts
    where "id" = ${shiftId}::uuid
      and "businessId" = ${businessId}::uuid
      and "storeId" = ${storeId}::uuid
      and "locationId" = ${locationId}::uuid
      and "status" = 'open'
    limit 1
  `.execute(context.transaction);
  if (!result.rows[0]) throw conflictError("No open register shift at this branch for the given shift");
}

export interface OrderRowSummary {
  readonly id: string;
  readonly orderNumber: string;
  readonly paymentStatus: string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
}

/** Creates the order and its immutadable priced lines for one POS charge. */
export async function createPosOrder(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  args: {
    storeId: string;
    channelId: string;
    locationId: string | null;
    assetCode: string;
    lines: PricedPosLine[];
    taxMinor: bigint;
    serviceChargeMinor: bigint;
    totalMinor: bigint;
  },
): Promise<OrderRowSummary> {
  const number = `POS-${Date.now().toString(36).toUpperCase()}-${args.lines[0]?.productVariantId.slice(0, 8).toUpperCase() ?? randomUUID().slice(0, 8).toUpperCase()}`;
  const subtotal = args.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0n);
  const order = (
    await sql<OrderRowSummary>`
      insert into app.orders (
        "businessId", "orderNumber", "storeId", "channelId", "locationId", "customerPartyId",
        "cartId", "currency", "subtotalMinor", "discountMinor", "taxMinor", "totalMinor",
        "paymentStatus", "createdBy"
      ) values (
        ${businessId}::uuid, ${number}, ${args.storeId}::uuid, ${args.channelId}::uuid,
        ${args.locationId ?? null}::uuid, null, null, ${args.assetCode}, ${subtotal.toString()},
        0, ${args.taxMinor.toString()}, ${args.totalMinor.toString()}, 'paid', ${userId}::uuid
      )
      returning "id"::text, "orderNumber", "paymentStatus", "currency",
                "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text
    `.execute(context.transaction)
  ).rows[0]!;

  for (const line of args.lines) {
    await sql`
      insert into app.order_lines (
        "businessId", "orderId", "productVariantId", "sku", "description", "quantity",
        "unitPriceMinor", "lineTotalMinor", "assetCode", "selectedModifiers"
      ) values (
        ${businessId}::uuid, ${order.id}::uuid, ${line.productVariantId}::uuid, ${line.sku},
        ${line.description}, ${line.quantity}, ${line.unitMinor.toString()},
        ${line.lineTotalMinor.toString()}, ${args.assetCode}, ${JSON.stringify(line.selectedModifiers)}::jsonb
      )
    `.execute(context.transaction);
  }
  return order;
}

export async function recordPayment(
  context: DatabaseContext,
  businessId: string,
  userId: string,
  orderId: string,
  amountMinor: bigint,
  method: string,
  assetCode: string,
): Promise<void> {
  await sql`
    insert into app.payments (
      "businessId", "orderId", "method", "status", "assetCode", "amountMinor",
      "idempotencyKey", "createdBy"
    ) values (
      ${businessId}::uuid, ${orderId}::uuid, ${method}, 'captured', ${assetCode},
      ${amountMinor.toString()}, ${randomUUID()}, ${userId}::uuid
    )
  `.execute(context.transaction);
}

export interface BookingChargeRow {
  readonly id: string;
  readonly orderId: string | null;
  readonly status: string;
}

export async function bookingChargeState(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
): Promise<BookingChargeRow | undefined> {
  return (
    await sql<BookingChargeRow>`
      select "id", "orderId", "status" from app.bookings
      where "id" = ${bookingId}::uuid and "businessId" = ${businessId}::uuid limit 1
    `.execute(context.transaction)
  ).rows[0];
}

/** Attaches the sale to the booking, completes it, and prices its items retroactively. */
export async function completeBookingAtTill(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
  orderId: string,
  resolvedItems: { bookingItemId: string; unitMinor: bigint }[],
): Promise<void> {
  await sql`
    update app.bookings
      set "orderId" = ${orderId}::uuid, "status" = 'completed', "holdExpiresAt" = null, "updatedAt" = now()
    where "id" = ${bookingId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(context.transaction);

  for (const item of resolvedItems) {
    await sql`
      update app.booking_items
        set "priceMinor" = ${item.unitMinor.toString()}, "updatedAt" = now()
      where "id" = ${item.bookingItemId}::uuid and "businessId" = ${businessId}::uuid
    `.execute(context.transaction);
  }
}

/** Upserts a per-staff gratuity for a booking so the commission report sums one tip per performer. */
export async function upsertBookingTip(
  context: DatabaseContext,
  businessId: string,
  bookingId: string,
  orderId: string,
  staffId: string | null,
  amountMinor: bigint,
): Promise<void> {
  await sql`
    insert into app.booking_tips ("businessId", "bookingId", "orderId", "staffId", "amountMinor")
    values (${businessId}::uuid, ${bookingId}::uuid, ${orderId}::uuid, ${staffId ?? null}::uuid, ${amountMinor.toString()})
    on conflict ("bookingId", "businessId", "staffId")
    do update set "amountMinor" = excluded."amountMinor", "orderId" = excluded."orderId"
  `.execute(context.transaction);
}

/** Captured money already received against an order — the deposit net-off. */
export async function capturedForOrder(context: DatabaseContext, businessId: string, orderId: string): Promise<bigint> {
  const result = await sql<{ total: string | null }>`
    select sum("amountMinor")::text as "total"
    from app.payments
    where "businessId" = ${businessId}::uuid and "orderId" = ${orderId}::uuid and "status" = 'captured'
  `.execute(context.transaction);
  return BigInt(result.rows[0]?.total ?? "0");
}

export async function orderById(
  context: DatabaseContext,
  businessId: string,
  orderId: string,
): Promise<OrderRowSummary | undefined> {
  return (
    await sql<OrderRowSummary>`
      select "id"::text, "orderNumber", "paymentStatus", "currency",
             "subtotalMinor"::text, "taxMinor"::text, "totalMinor"::text
      from app.orders
      where "businessId" = ${businessId}::uuid and "id" = ${orderId}::uuid
      limit 1
    `.execute(context.transaction)
  ).rows[0];
}

export interface OrderLineRowSummary {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: string;
  readonly lineTotalMinor: string;
  readonly productVariantId: string;
}

export async function orderLines(
  context: DatabaseContext,
  businessId: string,
  orderId: string,
): Promise<OrderLineRowSummary[]> {
  return (
    await sql<OrderLineRowSummary>`
      select "description", "quantity", "unitPriceMinor", "lineTotalMinor", "productVariantId"
      from app.order_lines
      where "businessId" = ${businessId}::uuid and "orderId" = ${orderId}::uuid
      order by "createdAt", "id"
    `.execute(context.transaction)
  ).rows;
}

export async function tipsForOrder(
  context: DatabaseContext,
  businessId: string,
  orderId: string,
): Promise<{ amountMinor: string; staffId: string | null; bookingId: string }[]> {
  return (
    await sql<{ amountMinor: string; staffId: string | null; bookingId: string }>`
      select "amountMinor", "staffId", "bookingId"
      from app.booking_tips
      where "businessId" = ${businessId}::uuid and "orderId" = ${orderId}::uuid
    `.execute(context.transaction)
  ).rows;
}

/** Prices ticket lines server-side; used by both preview and charge so they can never diverge. */
export async function pricePosLines(
  context: DatabaseContext,
  businessId: string,
  lines: PosLineInput[],
  locationId: string | null,
  assetCode: string,
): Promise<PricedPosLine[]> {
  const priced: PricedPosLine[] = [];
  for (const line of lines) {
    const variantId = line.variantId ?? (await defaultVariantId(context, businessId, line.productId));
    if (!variantId) throw notFoundError(`No sellable variant for product ${line.productId}`);
    const price = await resolveVariantPrice(context, businessId, variantId, locationId, assetCode);
    const adjustment = await modifierAdjustmentMinor(context, businessId, line.modifierOptionIds);
    const unitMinor = BigInt(price.unitMinor) + adjustment;
    const lineTotal = unitMinor * BigInt(line.quantity);
    const selectedModifiers = line.modifierOptionIds.reduce<Record<string, unknown>>(
      (acc, optionId) => ({ ...acc, [optionId]: 1 }),
      {},
    );
    priced.push({
      productVariantId: variantId,
      description: price.description,
      sku: price.sku,
      quantity: line.quantity,
      unitMinor,
      lineTotalMinor: lineTotal,
      staffId: null,
      selectedModifiers,
    });
  }
  return priced;
}

const TILL_STATUSES: readonly string[] = ["arrived", "in_service"];

/**
 * Today's arrived + in-service bookings for a store, day-bound in the
 * location/store timezone so the till mirrors what the front desk sees.
 */
export async function tillBookings(
  context: DatabaseContext,
  businessId: string,
  storeId: string,
): Promise<BookingRow[]> {
  const result = await sql<BookingRow>`
    select bookings."id", bookings."businessId", bookings."storeId", bookings."locationId",
           bookings."orderId", bookings."customerName", bookings."customerEmail", bookings."customerPhone",
           bookings."status", bookings."source", bookings."startsAt", bookings."endsAt",
           bookings."holdExpiresAt", bookings."manageToken", bookings."notes", bookings."cancelledReason",
           bookings."requiresApproval", bookings."initiatedBy", bookings."createdAt", bookings."updatedAt",
           coalesce((select loc."timezone" from app.locations loc where loc."id" = bookings."locationId"),
                    store."timezone")::text as "timezone"
    from app.bookings bookings
    join app.stores store on store."id" = bookings."storeId"
    where bookings."businessId" = ${businessId}::uuid
      and bookings."storeId" = ${storeId}::uuid
      and bookings."status" = any(${TILL_STATUSES}::text[])
      and (bookings."startsAt" at time zone
             coalesce((select loc."timezone" from app.locations loc where loc."id" = bookings."locationId"),
                       store."timezone"))::date
          =
          (now() at time zone
             coalesce((select loc."timezone" from app.locations loc where loc."id" = bookings."locationId"),
                       store."timezone"))::date
    order by bookings."startsAt"
  `.execute(context.transaction);
  const rows = result.rows;
  if (rows.length === 0) return [];
  await attachTillItems(context, businessId, rows);
  return rows;
}

async function attachTillItems(context: DatabaseContext, businessId: string, rows: BookingRow[]): Promise<void> {
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