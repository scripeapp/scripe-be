import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { AuditEventRow, ListAuditEventsFilter, LogAuditEventInput } from "./audit.types.js";

/**
 * Not called by any route — other domains' service code calls this
 * directly, within their own transaction, to record a privileged or
 * business-mutating action.
 */
export async function log(context: DatabaseContext, input: LogAuditEventInput): Promise<AuditEventRow> {
  const result = await sql<AuditEventRow>`
    insert into app.audit_events (
      "businessId", "actorUserId", "action", "targetType", "targetId", "metadata", "ipAddress", "userAgent", "requestId"
    ) values (
      ${input.businessId}::uuid, ${input.actorUserId}::uuid, ${input.action}, ${input.targetType ?? null}, ${input.targetId ?? null},
      ${JSON.stringify(input.metadata ?? {})}::jsonb, ${input.ipAddress ?? null}, ${input.userAgent ?? null}, ${input.requestId ?? null}
    )
    returning "id", "businessId", "actorUserId", "action", "targetType", "targetId", "metadata", "ipAddress", "userAgent", "requestId", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
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
