import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";

export interface AvailabilityRow {
  readonly id: string;
  readonly businessId: string;
  readonly name: string;
  readonly status: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface EventTypeRow {
  readonly id: string;
  readonly businessId: string;
  readonly slug: string;
  readonly title: string;
  readonly isActive: boolean;
  readonly availabilityProfileId: string | null;
  readonly data: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// ── Availability profiles ────────────────────────────────────────────────────

export async function listAvailability(context: DatabaseContext, businessId: string): Promise<AvailabilityRow[]> {
  const result = await sql<AvailabilityRow>`
    select "id", "businessId", "name", "status", "data", "createdAt", "updatedAt"
    from app.availability_profiles
    where "businessId" = ${businessId}::uuid
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function getAvailability(context: DatabaseContext, businessId: string, id: string): Promise<AvailabilityRow | undefined> {
  const result = await sql<AvailabilityRow>`
    select "id", "businessId", "name", "status", "data", "createdAt", "updatedAt"
    from app.availability_profiles
    where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function businessIdForAvailability(context: DatabaseContext, id: string): Promise<string | undefined> {
  const result = await sql<{ businessId: string }>`
    select "businessId" from app.availability_profiles where "id" = ${id}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0]?.businessId;
}

export async function createAvailability(
  context: DatabaseContext,
  businessId: string,
  input: { name: string; status: string; data: Record<string, unknown> },
): Promise<AvailabilityRow> {
  const result = await sql<AvailabilityRow>`
    insert into app.availability_profiles ("businessId", "name", "status", "data")
    values (${businessId}::uuid, ${input.name}, ${input.status}, ${JSON.stringify(input.data)}::jsonb)
    returning "id", "businessId", "name", "status", "data", "createdAt", "updatedAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateAvailability(
  context: DatabaseContext,
  businessId: string,
  id: string,
  input: { name: string; status: string; data: Record<string, unknown> },
): Promise<AvailabilityRow | undefined> {
  const result = await sql<AvailabilityRow>`
    update app.availability_profiles
    set "name" = ${input.name}, "status" = ${input.status},
        "data" = ${JSON.stringify(input.data)}::jsonb, "updatedAt" = now()
    where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid
    returning "id", "businessId", "name", "status", "data", "createdAt", "updatedAt"
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteAvailability(context: DatabaseContext, businessId: string, id: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    delete from app.availability_profiles
    where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ── Event types ──────────────────────────────────────────────────────────────

export async function listEventTypes(context: DatabaseContext, businessId: string): Promise<EventTypeRow[]> {
  const result = await sql<EventTypeRow>`
    select "id", "businessId", "slug", "title", "isActive", "availabilityProfileId", "data", "createdAt", "updatedAt"
    from app.event_types
    where "businessId" = ${businessId}::uuid
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function businessIdForEventType(context: DatabaseContext, id: string): Promise<string | undefined> {
  const result = await sql<{ businessId: string }>`
    select "businessId" from app.event_types where "id" = ${id}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0]?.businessId;
}

export async function createEventType(
  context: DatabaseContext,
  businessId: string,
  input: { slug: string; title: string; isActive: boolean; availabilityProfileId: string | null; data: Record<string, unknown> },
): Promise<EventTypeRow> {
  const result = await sql<EventTypeRow>`
    insert into app.event_types ("businessId", "slug", "title", "isActive", "availabilityProfileId", "data")
    values (${businessId}::uuid, ${input.slug}, ${input.title}, ${input.isActive},
            ${input.availabilityProfileId}, ${JSON.stringify(input.data)}::jsonb)
    returning "id", "businessId", "slug", "title", "isActive", "availabilityProfileId", "data", "createdAt", "updatedAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateEventType(
  context: DatabaseContext,
  businessId: string,
  id: string,
  input: { slug: string; title: string; isActive: boolean; availabilityProfileId: string | null; data: Record<string, unknown> },
): Promise<EventTypeRow | undefined> {
  const result = await sql<EventTypeRow>`
    update app.event_types
    set "slug" = ${input.slug}, "title" = ${input.title}, "isActive" = ${input.isActive},
        "availabilityProfileId" = ${input.availabilityProfileId},
        "data" = ${JSON.stringify(input.data)}::jsonb, "updatedAt" = now()
    where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid
    returning "id", "businessId", "slug", "title", "isActive", "availabilityProfileId", "data", "createdAt", "updatedAt"
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteEventType(context: DatabaseContext, businessId: string, id: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    delete from app.event_types
    where "id" = ${id}::uuid and "businessId" = ${businessId}::uuid returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}
