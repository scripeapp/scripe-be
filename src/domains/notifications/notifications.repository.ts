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
 * The preference category an event type belongs to; the Settings ›
 * Notifications switches are per category and channel. Types outside every
 * category (none today besides tests) are always delivered.
 */
export type NotificationCategory = "sales" | "deposits" | "team";

export function notificationCategory(type: string): NotificationCategory | null {
  if (type.startsWith("invoice.") || type.startsWith("paylink.")) return "sales";
  if (type.startsWith("deposit.")) return "deposits";
  if (type.startsWith("team.")) return "team";
  return null;
}

/** Whether the user wants this category on this channel (no saved preference means yes). Works without a signed-in user. */
export async function isNotificationEnabled(context: DatabaseContext, userId: string, category: NotificationCategory, channel: NotificationChannel): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select app.notification_enabled(${userId}::uuid, ${category}, ${channel}) as "enabled"
  `.execute(context.transaction);
  return result.rows[0]?.enabled ?? true;
}

/** isNotificationEnabled for a recipient known only by email address; an address that is no user's is always sent to. */
export async function isNotificationEnabledForEmail(context: DatabaseContext, email: string, category: NotificationCategory, channel: NotificationChannel): Promise<boolean> {
  const result = await sql<{ enabled: boolean }>`
    select app.notification_enabled_for_email(${email}, ${category}, ${channel}) as "enabled"
  `.execute(context.transaction);
  return result.rows[0]?.enabled ?? true;
}

/**
 * Whether to send a merchant email in this category, for senders on a
 * payment or webhook path: the lookup runs under its own savepoint so a
 * failure never aborts the caller's transaction, and errs towards sending.
 */
export async function wantsEmail(context: DatabaseContext, email: string, category: NotificationCategory): Promise<boolean> {
  await sql`savepoint notification_preference`.execute(context.transaction);
  try {
    const enabled = await isNotificationEnabledForEmail(context, email, category, "email");
    await sql`release savepoint notification_preference`.execute(context.transaction);
    return enabled;
  } catch (error) {
    await sql`rollback to savepoint notification_preference`.execute(context.transaction);
    console.warn("[notifications] could not read email preference:", error);
    return true;
  }
}

async function wantsInApp(context: DatabaseContext, input: CreateNotificationInput): Promise<boolean> {
  const category = notificationCategory(input.type);
  return category === null || (await isNotificationEnabled(context, input.userId, category, "in_app"));
}

/**
 * Server-side domain code calls this directly (e.g. a team invitation). The
 * recipient is data, not the caller's own identity, so this intentionally
 * does not go through requirePermission. Returns undefined when the
 * recipient has turned in-app notifications off for this category.
 */
export async function createNotification(context: DatabaseContext, input: CreateNotificationInput): Promise<NotificationRow | undefined> {
  if (!(await wantsInApp(context, input))) return undefined;
  const result = await sql<NotificationRow>`
    insert into app.notifications ("userId", "businessId", "type", "title", "body", "data")
    values (${input.userId}::uuid, ${input.businessId ?? null}::uuid, ${input.type}, ${input.title}, ${input.body ?? ""}, ${JSON.stringify(input.data ?? {})}::jsonb)
    returning "id", "userId", "businessId", "type", "title", "body", "data", "readAt", "archivedAt", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

/**
 * createNotification for callers with no signed-in user (webhooks, public
 * pages, jobs). Same insert, but without RETURNING: RETURNING must also pass
 * the "select own notifications" policy, which no anonymous caller can.
 */
export async function createSystemNotification(context: DatabaseContext, input: CreateNotificationInput): Promise<void> {
  if (!(await wantsInApp(context, input))) return;
  await sql`
    insert into app.notifications ("userId", "businessId", "type", "title", "body", "data")
    values (${input.userId}::uuid, ${input.businessId ?? null}::uuid, ${input.type}, ${input.title}, ${input.body ?? ""}, ${JSON.stringify(input.data ?? {})}::jsonb)
  `.execute(context.transaction);
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
