import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { AuditEventRow, ListAuditEventsFilter, LogAuditEventInput } from "./audit.types.js";

/**
 * Not called by any route — other domains' service code calls this
 * directly, within their own transaction, to record a privileged or
 * business-mutating action.
 *
 * No RETURNING here deliberately: audit_events_insert allows any actor to
 * record an event regardless of their own permissions (e.g. a newly
 * accepted invitee logging their own "team.member_joined" before they hold
 * any business permission at all), but RETURNING re-checks the row against
 * the SELECT policy, which requires 'audit.read' — that would abort the
 * insert (and the whole transaction) for any actor who can write an event
 * but can't yet read the log back.
 */
export async function log(context: DatabaseContext, input: LogAuditEventInput): Promise<void> {
  await sql`
    insert into app.audit_events (
      "businessId", "actorUserId", "action", "targetType", "targetId", "metadata", "ipAddress", "userAgent", "requestId"
    ) values (
      ${input.businessId}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.targetType ?? null}, ${input.targetId ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb, ${input.ipAddress ?? null}, ${input.userAgent ?? null}, ${input.requestId ?? null}
    )
  `.execute(context.transaction);
}

export async function listForBusiness(context: DatabaseContext, businessId: string, filter: ListAuditEventsFilter): Promise<AuditEventRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`"businessId" = ${businessId}::uuid`];
  if (filter.action) clauses.push(sql`"action" = ${filter.action}`);
  const limit = filter.limit ?? 50;

  const result = await sql<AuditEventRow>`
    select "id", "businessId", "actorUserId", "action", "targetType", "targetId", "metadata", "ipAddress", "userAgent", "requestId", "createdAt"
    from app.audit_events
    where ${sql.join(clauses, sql` and `)}
    order by "createdAt" desc
    limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function listAll(context: DatabaseContext, filter: ListAuditEventsFilter): Promise<AuditEventRow[]> {
  const clauses: RawBuilder<unknown>[] = [];
  if (filter.action) clauses.push(sql`"action" = ${filter.action}`);
  const limit = filter.limit ?? 50;

  const whereClause = clauses.length > 0 ? sql`where ${sql.join(clauses, sql` and `)}` : sql``;

  const result = await sql<AuditEventRow>`
    select "id", "businessId", "actorUserId", "action", "targetType", "targetId", "metadata", "ipAddress", "userAgent", "requestId", "createdAt"
    from app.audit_events
    ${whereClause}
    order by "createdAt" desc
    limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}
