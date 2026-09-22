import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  CreateNotificationInput,
  ListNotificationsFilter,
  NotificationChannel,
  NotificationPreferenceRow,
  NotificationRow,
} from "./notifications.types.js";

/**
 * Not called by any route in this slice — server-side domain code calls this
 * directly once a real notification trigger is evidenced (e.g. a team
 * invitation, an order event). The recipient is data, not the caller's own
 * identity, so this intentionally does not go through requirePermission.
 */
export async function createNotification(context: DatabaseContext, input: CreateNotificationInput): Promise<NotificationRow> {
  const result = await sql<NotificationRow>`
    insert into app.notifications ("userId", "businessId", "type", "title", "body", "data")
    values (${input.userId}::uuid, ${input.businessId ?? null}::uuid, ${input.type}, ${input.title}, ${input.body ?? ""}, ${JSON.stringify(input.data ?? {})}::jsonb)
    returning "id", "userId", "businessId", "type", "title", "body", "data", "readAt", "archivedAt", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function listForUser(context: DatabaseContext, userId: string, filter: ListNotificationsFilter): Promise<NotificationRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"userId" = ${userId}::uuid`];
  if (!filter.includeArchived) clauses.push(sql`"archivedAt" is null`);
  if (filter.unreadOnly) clauses.push(sql`"readAt" is null`);
  const limit = filter.limit ?? 50;

  const result = await sql<NotificationRow>`
    select "id", "userId", "businessId", "type", "title", "body", "data", "readAt", "archivedAt", "createdAt"
    from app.notifications
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function countUnread(context: DatabaseContext, userId: string): Promise<number> {
  const result = await sql<{ count: string }>`
    select count(*)::text as "count" from app.notifications
    where "userId" = ${userId}::uuid and "readAt" is null and "archivedAt" is null
  `.execute(context.transaction);
  return Number(result.rows[0]?.count ?? "0");
}

export async function findForUser(context: DatabaseContext, userId: string, notificationId: string): Promise<NotificationRow | undefined> {
  const result = await sql<NotificationRow>`
    select "id", "userId", "businessId", "type", "title", "body", "data", "readAt", "archivedAt", "createdAt"
    from app.notifications where "userId" = ${userId}::uuid and "id" = ${notificationId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function updateNotification(
  context: DatabaseContext,
  userId: string,
  notificationId: string,
  fields: { readAt?: Date | null; archivedAt?: Date | null },
): Promise<NotificationRow | undefined> {
  const assignments: RawBuilder<unknown>[] = [];
  if (fields.readAt !== undefined) assignments.push(sql`"readAt" = ${fields.readAt}`);
  if (fields.archivedAt !== undefined) assignments.push(sql`"archivedAt" = ${fields.archivedAt}`);
  if (assignments.length === 0) return findForUser(context, userId, notificationId);

  const result = await sql<NotificationRow>`
    update app.notifications set ${sql.join(assignments, sql`, `)}
    where "userId" = ${userId}::uuid and "id" = ${notificationId}::uuid
    returning "id", "userId", "businessId", "type", "title", "body", "data", "readAt", "archivedAt", "createdAt"
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listPreferences(context: DatabaseContext, userId: string): Promise<NotificationPreferenceRow[]> {
  const result = await sql<NotificationPreferenceRow>`
    select "userId", "type", "channel", "enabled", "updatedAt" from app.notification_preferences
    where "userId" = ${userId}::uuid
    order by "type", "channel"
  `.execute(context.transaction);
  return result.rows;
}

export async function setPreference(context: DatabaseContext, userId: string, type: string, channel: NotificationChannel, enabled: boolean): Promise<NotificationPreferenceRow> {
  const result = await sql<NotificationPreferenceRow>`
    insert into app.notification_preferences ("userId", "type", "channel", "enabled")
    values (${userId}::uuid, ${type}, ${channel}, ${enabled})
    on conflict ("userId", "type", "channel") do update set "enabled" = excluded."enabled", "updatedAt" = now()
    returning "userId", "type", "channel", "enabled", "updatedAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

/** Absence of a row means "no override" — defaults to enabled, matching legacy's mostly-opt-out defaults for transactional notifications. */
export async function isEnabled(context: DatabaseContext, userId: string, type: string, channel: NotificationChannel): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select "enabled" from app.notification_preferences
    where "userId" = ${userId}::uuid and "type" = ${type} and "channel" = ${channel}
  `.execute(context.transaction);
  return result.rows[0]?.enabled ?? true;
}
