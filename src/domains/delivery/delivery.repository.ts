import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  CreateDeliveryMethodInput,
  CreateDeliveryZoneInput,
  DeliveryAddress,
  DeliveryMethodRow,
  DeliveryRow,
  DeliveryStatus,
  DeliveryTrackingEvent,
  DeliveryZoneRow,
  UpdateDeliveryMethodInput,
  UpdateDeliveryZoneInput,
  ZoneMatch,
} from "./delivery.types.js";

const METHOD_COLUMNS = sql`"id", "businessId", "storeId", "name", "description", "priceMinor"::text as "priceMinor", "estimatedTime", "isActive", "sortOrder", "createdAt", "updatedAt"`;

export async function listMethods(context: DatabaseContext, businessId: string, storeId: string | undefined): Promise<DeliveryMethodRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"businessId" = ${businessId}::uuid`];
  if (storeId) clauses.push(sql`"storeId" = ${storeId}::uuid`);
  const result = await sql<DeliveryMethodRow>`
    select ${METHOD_COLUMNS} from app.delivery_methods where ${sql.join(clauses, sql` and `)} order by "sortOrder", "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findMethod(context: DatabaseContext, businessId: string, methodId: string): Promise<DeliveryMethodRow | undefined> {
  const result = await sql<DeliveryMethodRow>`
    select ${METHOD_COLUMNS} from app.delivery_methods where "businessId" = ${businessId}::uuid and "id" = ${methodId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createMethod(context: DatabaseContext, businessId: string, input: CreateDeliveryMethodInput): Promise<DeliveryMethodRow> {
  const result = await sql<DeliveryMethodRow>`
    insert into app.delivery_methods ("businessId", "storeId", "name", "description", "priceMinor", "estimatedTime", "isActive", "sortOrder")
    values (
      ${businessId}::uuid, ${input.storeId}::uuid, ${input.name}, ${input.description ?? null}, ${input.priceMinor ?? 0}::bigint,
      ${input.estimatedTime ?? null}, ${input.isActive ?? true},
      coalesce(${input.sortOrder ?? null}, (select coalesce(max("sortOrder"), -1) + 1 from app.delivery_methods where "businessId" = ${businessId}::uuid and "storeId" = ${input.storeId}::uuid))
    )
    returning ${METHOD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateMethod(context: DatabaseContext, businessId: string, methodId: string, input: UpdateDeliveryMethodInput): Promise<DeliveryMethodRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.description !== undefined) fields.push(sql`"description" = ${input.description}`);
  if (input.priceMinor !== undefined) fields.push(sql`"priceMinor" = ${input.priceMinor}::bigint`);
  if (input.estimatedTime !== undefined) fields.push(sql`"estimatedTime" = ${input.estimatedTime}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (input.sortOrder !== undefined) fields.push(sql`"sortOrder" = ${input.sortOrder}`);
  if (fields.length === 0) return findMethod(context, businessId, methodId);

  const result = await sql<DeliveryMethodRow>`
    update app.delivery_methods set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${methodId}::uuid
    returning ${METHOD_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

/** Soft delete, matching legacy (delivery methods can be referenced by past orders/deliveries, so they are deactivated, not removed). */
export async function deactivateMethod(context: DatabaseContext, businessId: string, methodId: string): Promise<boolean> {
  const result = await sql`
    update app.delivery_methods set "isActive" = false where "businessId" = ${businessId}::uuid and "id" = ${methodId}::uuid
  `.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function reorderMethods(context: DatabaseContext, businessId: string, storeId: string, orderedIds: readonly string[]): Promise<void> {
  for (let index = 0; index < orderedIds.length; index += 1) {
    await sql`
      update app.delivery_methods set "sortOrder" = ${index}
      where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "id" = ${orderedIds[index]}::uuid
    `.execute(context.transaction);
  }
}

export async function countMethodsMatching(context: DatabaseContext, businessId: string, storeId: string, methodIds: readonly string[]): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as "count" from app.delivery_methods where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "id" = any(${methodIds}::uuid[])
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? "0");
}

const ZONE_COLUMNS = sql`
  "id", "businessId", "storeId", "locationId", "zipCode", "feeMinor"::text as "feeMinor", "minOrderMinor"::text as "minOrderMinor",
  "estimatedMinutes", "isActive", "createdAt", "updatedAt"
`;

export async function listZones(context: DatabaseContext, businessId: string, storeId: string | undefined): Promise<DeliveryZoneRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"businessId" = ${businessId}::uuid`];
  if (storeId) clauses.push(sql`"storeId" = ${storeId}::uuid`);
  const result = await sql<DeliveryZoneRow>`
    select ${ZONE_COLUMNS} from app.delivery_zones where ${sql.join(clauses, sql` and `)} order by "zipCode"
  `.execute(context.transaction);
  return result.rows;
}

export async function findZone(context: DatabaseContext, businessId: string, zoneId: string): Promise<DeliveryZoneRow | undefined> {
  const result = await sql<DeliveryZoneRow>`
    select ${ZONE_COLUMNS} from app.delivery_zones where "businessId" = ${businessId}::uuid and "id" = ${zoneId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createZone(context: DatabaseContext, businessId: string, input: CreateDeliveryZoneInput): Promise<DeliveryZoneRow> {
  const result = await sql<DeliveryZoneRow>`
    insert into app.delivery_zones ("businessId", "storeId", "locationId", "zipCode", "feeMinor", "minOrderMinor", "estimatedMinutes", "isActive")
    values (
      ${businessId}::uuid, ${input.storeId}::uuid, ${input.locationId}::uuid, ${input.zipCode}, ${input.feeMinor ?? 0}::bigint,
      ${input.minOrderMinor ?? null}::bigint, ${input.estimatedMinutes ?? null}, ${input.isActive ?? true}
    )
    returning ${ZONE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateZone(context: DatabaseContext, businessId: string, zoneId: string, input: UpdateDeliveryZoneInput): Promise<DeliveryZoneRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.zipCode !== undefined) fields.push(sql`"zipCode" = ${input.zipCode}`);
  if (input.feeMinor !== undefined) fields.push(sql`"feeMinor" = ${input.feeMinor}::bigint`);
  if (input.minOrderMinor !== undefined) fields.push(sql`"minOrderMinor" = ${input.minOrderMinor}::bigint`);
  if (input.estimatedMinutes !== undefined) fields.push(sql`"estimatedMinutes" = ${input.estimatedMinutes}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (fields.length === 0) return findZone(context, businessId, zoneId);

  const result = await sql<DeliveryZoneRow>`
    update app.delivery_zones set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${zoneId}::uuid
    returning ${ZONE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteZone(context: DatabaseContext, businessId: string, zoneId: string): Promise<boolean> {
  const result = await sql`delete from app.delivery_zones where "businessId" = ${businessId}::uuid and "id" = ${zoneId}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export async function matchZone(context: DatabaseContext, businessId: string, storeId: string, locationId: string, zipCode: string): Promise<ZoneMatch | undefined> {
  const result = await sql<ZoneMatch>`
    select "feeMinor"::text as "feeMinor", "minOrderMinor"::text as "minOrderMinor", "estimatedMinutes"
    from app.delivery_zones
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "locationId" = ${locationId}::uuid and "zipCode" = ${zipCode} and "isActive"
  `.execute(context.transaction);
  return result.rows[0];
}

const DELIVERY_COLUMNS = sql`
  "id", "businessId", "orderId", "fulfillmentId", "storeId", "deliveryMethodId", "provider", "status",
  "courierName", "serviceCode", "courierId", "trackingCode", "trackingUrl", "labelUrl", "feeMinor"::text as "feeMinor",
  "destination", "events", "createdBy", "createdAt", "updatedAt"
`;

export async function listDeliveriesForOrder(context: DatabaseContext, businessId: string, orderId: string): Promise<DeliveryRow[]> {
  const result = await sql<DeliveryRow>`
    select ${DELIVERY_COLUMNS} from app.deliveries where "businessId" = ${businessId}::uuid and "orderId" = ${orderId}::uuid order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findDelivery(context: DatabaseContext, businessId: string, deliveryId: string): Promise<DeliveryRow | undefined> {
  const result = await sql<DeliveryRow>`
    select ${DELIVERY_COLUMNS} from app.deliveries where "businessId" = ${businessId}::uuid and "id" = ${deliveryId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createDelivery(
  context: DatabaseContext,
  businessId: string,
  createdBy: string,
  input: {
    orderId: string;
    fulfillmentId: string | null;
    storeId: string;
    deliveryMethodId: string | null;
    provider: "shipbubble" | null;
    destination: DeliveryAddress;
    feeMinor: number;
  },
): Promise<DeliveryRow> {
  const result = await sql<DeliveryRow>`
    insert into app.deliveries ("businessId", "orderId", "fulfillmentId", "storeId", "deliveryMethodId", "provider", "destination", "feeMinor", "createdBy")
    values (
      ${businessId}::uuid, ${input.orderId}::uuid, ${input.fulfillmentId}::uuid, ${input.storeId}::uuid, ${input.deliveryMethodId}::uuid,
      ${input.provider}, ${JSON.stringify(input.destination)}::jsonb, ${input.feeMinor}::bigint, ${createdBy}::uuid
    )
    returning ${DELIVERY_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function markDeliveryBooked(
  context: DatabaseContext,
  deliveryId: string,
  fields: { courierName: string; serviceCode: string; courierId: string; trackingCode: string; trackingUrl: string; labelUrl: string | null },
): Promise<DeliveryRow | undefined> {
  const result = await sql<DeliveryRow>`
    update app.deliveries set
      "status" = 'booked', "courierName" = ${fields.courierName}, "serviceCode" = ${fields.serviceCode}, "courierId" = ${fields.courierId},
      "trackingCode" = ${fields.trackingCode}, "trackingUrl" = ${fields.trackingUrl}, "labelUrl" = ${fields.labelUrl}
    where "id" = ${deliveryId}::uuid
    returning ${DELIVERY_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function appendTrackingEvent(context: DatabaseContext, deliveryId: string, status: DeliveryStatus, event: DeliveryTrackingEvent): Promise<DeliveryRow | undefined> {
  const result = await sql<DeliveryRow>`
    update app.deliveries set "status" = ${status}, "events" = "events" || ${JSON.stringify([event])}::jsonb
    where "id" = ${deliveryId}::uuid
    returning ${DELIVERY_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export interface StoreLocationAddress {
  readonly locationId: string;
  readonly name: string | null;
  readonly phone: string | null;
  readonly addressLine1: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly countryCode: string;
}

/** Read-only reference lookup into the stores domain's app.locations - the "store pickup address" sender resolution needs, mirroring how other domains read shared reference data across a domain boundary (e.g. banking reading authorization's memberships). */
export async function findDefaultLocationAddress(context: DatabaseContext, businessId: string, storeId: string): Promise<StoreLocationAddress | undefined> {
  const result = await sql<StoreLocationAddress>`
    select "id" as "locationId", "name", "phone", "addressLine1", "city", "state", "countryCode"
    from app.locations
    where "businessId" = ${businessId}::uuid and "storeId" = ${storeId}::uuid and "isDefault" and "status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function setCarrierDeliveryEnabled(context: DatabaseContext, businessId: string, storeId: string, enabled: boolean): Promise<boolean> {
  const result = await sql`
    update app.stores set "carrierDeliveryEnabled" = ${enabled} where "id" = ${storeId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}

export interface WebhookDeliveryUpdate {
  readonly found: boolean;
  readonly businessId: string | null;
  readonly orderId: string | null;
}

/**
 * Called from the provider-events webhook context (an anonymous principal,
 * no caller business context) - goes through the security-definer function
 * rather than a direct UPDATE, the same escape hatch every other webhook
 * path in this codebase uses.
 */
export async function updateFromWebhookByTrackingCode(context: DatabaseContext, trackingCode: string, status: DeliveryStatus, event: DeliveryTrackingEvent): Promise<WebhookDeliveryUpdate> {
  const result = await sql<WebhookDeliveryUpdate>`
    select * from app.update_delivery_from_webhook(${trackingCode}, ${status}, ${JSON.stringify(event)}::jsonb)
  `.execute(context.transaction);
  return result.rows[0]!;
}
