import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  AdminAlertRow,
  CreateAdminAlertInput,
  CreatePlatformAdministratorInput,
  CreateSystemAnnouncementInput,
  ListAdminAlertsFilter,
  ListSystemAnnouncementsFilter,
  PlatformAdministratorRow,
  SystemAnnouncementRow,
  UpdatePlatformAdministratorInput,
  UpdateSystemAnnouncementInput,
} from "./platform.types.js";

const ADMINISTRATOR_COLUMNS = sql`
  "id", "userId", "role", "name", "email", "isActive", "permissions", "lastLoginAt", "createdBy", "createdAt", "updatedAt"
`;

export async function findAdministratorByUserId(context: DatabaseContext, userId: string): Promise<PlatformAdministratorRow | undefined> {
  const result = await sql<PlatformAdministratorRow>`
    select ${ADMINISTRATOR_COLUMNS} from app.platform_administrators where "userId" = ${userId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findAdministratorById(context: DatabaseContext, id: string): Promise<PlatformAdministratorRow | undefined> {
  const result = await sql<PlatformAdministratorRow>`
    select ${ADMINISTRATOR_COLUMNS} from app.platform_administrators where "id" = ${id}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listAdministrators(context: DatabaseContext): Promise<PlatformAdministratorRow[]> {
  const result = await sql<PlatformAdministratorRow>`
    select ${ADMINISTRATOR_COLUMNS} from app.platform_administrators order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

/** Resolves the target of a new administrator grant; the caller must already have an account. */
export async function findAuthUserByEmail(context: DatabaseContext, email: string): Promise<{ id: string; email: string; name: string } | undefined> {
  const result = await sql<{ id: string; email: string; name: string }>`
    select "id", "email", "name" from auth.user where lower("email") = lower(${email})
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createAdministrator(
  context: DatabaseContext,
  userId: string,
  createdBy: string | null,
  input: CreatePlatformAdministratorInput,
): Promise<PlatformAdministratorRow> {
  const result = await sql<PlatformAdministratorRow>`
    insert into app.platform_administrators ("userId", "role", "name", "email", "permissions", "createdBy")
    values (${userId}::uuid, ${input.role}, ${input.name}, ${input.email}, ${JSON.stringify(input.permissions ?? [])}::jsonb, ${createdBy}::uuid)
    returning ${ADMINISTRATOR_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateAdministrator(
  context: DatabaseContext,
  id: string,
  input: UpdatePlatformAdministratorInput,
): Promise<PlatformAdministratorRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.role !== undefined) fields.push(sql`"role" = ${input.role}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (input.permissions !== undefined) fields.push(sql`"permissions" = ${JSON.stringify(input.permissions)}::jsonb`);
  if (fields.length === 0) return findAdministratorById(context, id);

  const result = await sql<PlatformAdministratorRow>`
    update app.platform_administrators set ${sql.join(fields, sql`, `)}
    where "id" = ${id}::uuid
    returning ${ADMINISTRATOR_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

const ALERT_COLUMNS = sql`"id", "type", "severity", "title", "message", "metadata", "isRead", "readAt", "createdAt"`;

/**
 * Not called by any route - other domains' service code calls this directly,
 * within their own transaction, to raise a platform-level operational alert.
 */
export async function createAlert(context: DatabaseContext, input: CreateAdminAlertInput): Promise<AdminAlertRow> {
  const result = await sql<AdminAlertRow>`
    insert into app.admin_alerts ("type", "severity", "title", "message", "metadata")
    values (${input.type}, ${input.severity}, ${input.title}, ${input.message}, ${JSON.stringify(input.metadata ?? {})}::jsonb)
    returning ${ALERT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function listAlerts(context: DatabaseContext, filter: ListAdminAlertsFilter): Promise<{ rows: AdminAlertRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (filter.unreadOnly) clauses.push(sql`not "isRead"`);
  if (filter.severity) clauses.push(sql`"severity" = ${filter.severity}`);
  if (filter.type) clauses.push(sql`"type" = ${filter.type}`);
  const limit = filter.limit ?? 30;
  const offset = ((filter.page ?? 1) - 1) * limit;

  const result = await sql<AdminAlertRow & { totalCount: string }>`
    select ${ALERT_COLUMNS}, count(*) over ()::text as "totalCount"
    from app.admin_alerts
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);

  return { rows: result.rows, total: Number(result.rows[0]?.totalCount ?? "0") };
}

export async function countUnreadAlerts(context: DatabaseContext): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as "count" from app.admin_alerts where not "isRead"
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? "0");
}

export async function markAlertsRead(context: DatabaseContext, alertIds: string[] | undefined): Promise<void> {
  if (alertIds && alertIds.length === 0) return;
  if (alertIds) {
    await sql`
      update app.admin_alerts set "isRead" = true, "readAt" = now()
      where "id" = any(${alertIds}::uuid[]) and not "isRead"
    `.execute(context.transaction);
    return;
  }
  await sql`
    update app.admin_alerts set "isRead" = true, "readAt" = now() where not "isRead"
  `.execute(context.transaction);
}

const ANNOUNCEMENT_COLUMNS = sql`
  "id", "title", "body", "type", "audience", "ctaLabel", "ctaUrl", "isActive", "startsAt", "endsAt", "createdBy", "createdAt", "updatedAt"
`;

export async function listAnnouncements(context: DatabaseContext, filter: ListSystemAnnouncementsFilter): Promise<{ rows: SystemAnnouncementRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`true`];
  if (filter.activeOnly) clauses.push(sql`"isActive"`);
  const limit = filter.limit ?? 20;
  const offset = ((filter.page ?? 1) - 1) * limit;

  const result = await sql<SystemAnnouncementRow & { totalCount: string }>`
    select ${ANNOUNCEMENT_COLUMNS}, count(*) over ()::text as "totalCount"
    from app.system_announcements
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit} offset ${offset}
  `.execute(context.transaction);

  return { rows: result.rows, total: Number(result.rows[0]?.totalCount ?? "0") };
}

export async function findAnnouncementById(context: DatabaseContext, id: string): Promise<SystemAnnouncementRow | undefined> {
  const result = await sql<SystemAnnouncementRow>`
    select ${ANNOUNCEMENT_COLUMNS} from app.system_announcements where "id" = ${id}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createAnnouncement(context: DatabaseContext, createdBy: string, input: CreateSystemAnnouncementInput): Promise<SystemAnnouncementRow> {
  const result = await sql<SystemAnnouncementRow>`
    insert into app.system_announcements (
      "title", "body", "type", "audience", "ctaLabel", "ctaUrl", "isActive", "startsAt", "endsAt", "createdBy"
    ) values (
      ${input.title}, ${input.body}, ${input.type}, ${input.audience},
      ${input.ctaLabel ?? null}, ${input.ctaUrl ?? null}, ${input.isActive ?? true},
      ${input.startsAt ?? null}, ${input.endsAt ?? null}, ${createdBy}::uuid
    )
    returning ${ANNOUNCEMENT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateAnnouncement(context: DatabaseContext, id: string, input: UpdateSystemAnnouncementInput): Promise<SystemAnnouncementRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.title !== undefined) fields.push(sql`"title" = ${input.title}`);
  if (input.body !== undefined) fields.push(sql`"body" = ${input.body}`);
  if (input.type !== undefined) fields.push(sql`"type" = ${input.type}`);
  if (input.audience !== undefined) fields.push(sql`"audience" = ${input.audience}`);
  if (input.ctaLabel !== undefined) fields.push(sql`"ctaLabel" = ${input.ctaLabel}`);
  if (input.ctaUrl !== undefined) fields.push(sql`"ctaUrl" = ${input.ctaUrl}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (input.startsAt !== undefined) fields.push(sql`"startsAt" = ${input.startsAt}`);
  if (input.endsAt !== undefined) fields.push(sql`"endsAt" = ${input.endsAt}`);
  if (fields.length === 0) return findAnnouncementById(context, id);

  const result = await sql<SystemAnnouncementRow>`
    update app.system_announcements set ${sql.join(fields, sql`, `)}
    where "id" = ${id}::uuid
    returning ${ANNOUNCEMENT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function deleteAnnouncement(context: DatabaseContext, id: string): Promise<boolean> {
  const result = await sql`delete from app.system_announcements where "id" = ${id}::uuid`.execute(context.transaction);
  return (result.numAffectedRows ?? 0n) > 0n;
}
