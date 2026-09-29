import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { CreateExceptionInput, CreateStaffInput, SetStaffScheduleInput, SetStaffServicesInput, UpdateStaffInput } from "./staff.schemas.js";
import type { CommissionReportRow, ScheduleExceptionRow, StaffProfileRow, StaffScheduleRow, StaffServiceRow } from "./staff.types.js";

const PROFILE_COLUMNS = sql`
  "id", "businessId", "membershipId", "partyId", "displayName",
  "photoUploadId", "isBookable", "commissionPercent", "createdAt", "updatedAt"
`;

// ── profiles ─────────────────────────────────────────────────────────────────

export async function listProfiles(context: DatabaseContext, businessId: string): Promise<StaffProfileRow[]> {
  const result = await sql<StaffProfileRow>`
    select ${PROFILE_COLUMNS} from app.staff_profiles
    where "businessId" = ${businessId}::uuid
    order by "displayName"
  `.execute(context.transaction);
  return result.rows;
}

export async function findProfile(context: DatabaseContext, businessId: string, staffId: string): Promise<StaffProfileRow | undefined> {
  const result = await sql<StaffProfileRow>`
    select ${PROFILE_COLUMNS} from app.staff_profiles
    where "id" = ${staffId}::uuid and "businessId" = ${businessId}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createProfile(context: DatabaseContext, businessId: string, input: CreateStaffInput): Promise<StaffProfileRow> {
  const result = await sql<StaffProfileRow>`
    insert into app.staff_profiles ("businessId", "membershipId", "partyId", "displayName", "photoUploadId", "isBookable", "commissionPercent")
    values (${businessId}::uuid, ${input.membershipId ?? null}, ${input.partyId ?? null}, ${input.displayName}, ${input.photoUploadId ?? null}, ${input.isBookable}, ${input.commissionPercent ?? 0})
    returning ${PROFILE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateProfile(context: DatabaseContext, businessId: string, staffId: string, input: UpdateStaffInput): Promise<StaffProfileRow | undefined> {
  const fields: RawBuilder<unknown>[] = [sql`"updatedAt" = now()`];
  if (input.displayName !== undefined) fields.push(sql`"displayName" = ${input.displayName}`);
  if (input.photoUploadId !== undefined) fields.push(sql`"photoUploadId" = ${input.photoUploadId}`);
  if (input.isBookable !== undefined) fields.push(sql`"isBookable" = ${input.isBookable}`);
  if (input.commissionPercent !== undefined) fields.push(sql`"commissionPercent" = ${input.commissionPercent}`);
  const result = await sql<StaffProfileRow>`
    update app.staff_profiles set ${sql.join(fields, sql`, `)}
    where "id" = ${staffId}::uuid and "businessId" = ${businessId}::uuid
    returning ${PROFILE_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteProfile(context: DatabaseContext, businessId: string, staffId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    delete from app.staff_profiles where "id" = ${staffId}::uuid and "businessId" = ${businessId}::uuid returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ── tenant-ownership guards ──────────────────────────────────────────────────

export async function countOwnedProducts(context: DatabaseContext, businessId: string, productIds: string[]): Promise<number> {
  if (productIds.length === 0) return 0;
  const result = await sql<{ count: string }>`
    select count(distinct "id")::text as count from app.products
    where "businessId" = ${businessId}::uuid and "id" = any(${productIds}::uuid[])
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? 0);
}

export async function countOwnedLocations(context: DatabaseContext, businessId: string, locationIds: string[]): Promise<number> {
  if (locationIds.length === 0) return 0;
  const result = await sql<{ count: string }>`
    select count(distinct "id")::text as count from app.locations
    where "businessId" = ${businessId}::uuid and "id" = any(${locationIds}::uuid[])
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? 0);
}

// ── services ─────────────────────────────────────────────────────────────────

export async function listServices(context: DatabaseContext, businessId: string, staffIds: string[]): Promise<StaffServiceRow[]> {
  if (staffIds.length === 0) return [];
  const result = await sql<StaffServiceRow>`
    select "id", "staffId", "productId", "variantId", "durationOverrideMinutes"
    from app.staff_services
    where "businessId" = ${businessId}::uuid and "staffId" = any(${staffIds}::uuid[])
  `.execute(context.transaction);
  return result.rows;
}

export async function replaceServices(context: DatabaseContext, businessId: string, staffId: string, input: SetStaffServicesInput): Promise<void> {
  await sql`delete from app.staff_services where "staffId" = ${staffId}::uuid and "businessId" = ${businessId}::uuid`.execute(context.transaction);
  for (const service of input.services) {
    await sql`
      insert into app.staff_services ("businessId", "staffId", "productId", "variantId", "durationOverrideMinutes")
      values (${businessId}::uuid, ${staffId}::uuid, ${service.productId}::uuid, ${service.variantId ?? null}, ${service.durationOverrideMinutes ?? null})
    `.execute(context.transaction);
  }
}

// ── schedule ─────────────────────────────────────────────────────────────────

export async function listSchedule(context: DatabaseContext, businessId: string, staffIds: string[]): Promise<StaffScheduleRow[]> {
  if (staffIds.length === 0) return [];
  const result = await sql<StaffScheduleRow>`
    select "id", "staffId", "locationId", "weekday", "startTime", "endTime"
    from app.staff_schedules
    where "businessId" = ${businessId}::uuid and "staffId" = any(${staffIds}::uuid[])
    order by "weekday", "startTime"
  `.execute(context.transaction);
  return result.rows;
}

export async function replaceSchedule(context: DatabaseContext, businessId: string, staffId: string, input: SetStaffScheduleInput): Promise<void> {
  await sql`delete from app.staff_schedules where "staffId" = ${staffId}::uuid and "businessId" = ${businessId}::uuid`.execute(context.transaction);
  for (const entry of input.entries) {
    await sql`
      insert into app.staff_schedules ("businessId", "staffId", "locationId", "weekday", "startTime", "endTime")
      values (${businessId}::uuid, ${staffId}::uuid, ${entry.locationId}::uuid, ${entry.weekday}, ${entry.startTime}, ${entry.endTime})
    `.execute(context.transaction);
  }
}

// ── exceptions ───────────────────────────────────────────────────────────────

export async function listExceptions(context: DatabaseContext, businessId: string, staffId?: string): Promise<ScheduleExceptionRow[]> {
  const result = await sql<ScheduleExceptionRow>`
    select "id", "businessId", "staffId", "locationId", "startsAt", "endsAt", "kind", "reason", "createdAt"
    from app.schedule_exceptions
    where "businessId" = ${businessId}::uuid
      and (${staffId ?? null}::uuid is null or "staffId" = ${staffId ?? null}::uuid)
    order by "startsAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function createException(context: DatabaseContext, businessId: string, input: CreateExceptionInput): Promise<ScheduleExceptionRow> {
  const result = await sql<ScheduleExceptionRow>`
    insert into app.schedule_exceptions ("businessId", "staffId", "locationId", "startsAt", "endsAt", "kind", "reason")
    values (${businessId}::uuid, ${input.staffId ?? null}, ${input.locationId ?? null}, ${input.startsAt}::timestamptz, ${input.endsAt}::timestamptz, ${input.kind}, ${input.reason ?? null})
    returning "id", "businessId", "staffId", "locationId", "startsAt", "endsAt", "kind", "reason", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function deleteException(context: DatabaseContext, businessId: string, exceptionId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    delete from app.schedule_exceptions where "id" = ${exceptionId}::uuid and "businessId" = ${businessId}::uuid returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ── commission report ────────────────────────────────────────────────────────

export async function commissionReport(context: DatabaseContext, businessId: string, from: Date, to: Date): Promise<CommissionReportRow[]> {
  const result = await sql<CommissionReportRow>`
    select
      sp."id" as "staffId",
      sp."displayName",
      sp."commissionPercent"::integer as "commissionPercent",
      coalesce(sum(bi."priceMinor") filter (where bi."status" = 'completed'), 0)::text as "revenueMinor",
      coalesce((select sum(t."amountMinor") from app.booking_tips t
                 where t."businessId" = sp."businessId"
                   and t."staffId" = sp."id"
                   and t."createdAt" >= ${from}::timestamptz
                   and t."createdAt" < ${to}::timestamptz), 0)::text as "tipsMinor",
      count(bi."id") filter (where bi."status" = 'completed')::text as "completedCount"
    from app.staff_profiles sp
    left join app.booking_items bi
      on bi."staffId" = sp."id"
     and bi."businessId" = sp."businessId"
     and bi."endsAt" >= ${from}::timestamptz
     and bi."endsAt" < ${to}::timestamptz
    where sp."businessId" = ${businessId}::uuid
    group by sp."id", sp."displayName", sp."commissionPercent"
    order by sp."displayName"
  `.execute(context.transaction);
  return result.rows;
}
