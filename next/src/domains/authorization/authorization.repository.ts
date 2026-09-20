import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";

/**
 * The single source of truth for "does this membership have this permission on this
 * business" — every domain must call this instead of re-querying
 * app.has_business_permission directly, so the check can only be implemented once.
 */
export async function findAuthorizedMembership(
  context: DatabaseContext,
  businessId: string,
  permission: string,
): Promise<string | undefined> {
  const result = await sql<{ membershipId: string }>`
    select membership."id" as "membershipId"
    from app.business_memberships membership
    where membership."businessId" = ${businessId}::uuid
      and membership."userId"::text = app.current_user_id()
      and membership."status" = 'active'
      and app.has_business_permission(${businessId}::uuid, ${permission})
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.membershipId;
}

export async function hasPermission(
  context: DatabaseContext,
  businessId: string,
  permission: string,
): Promise<boolean> {
  return (await findAuthorizedMembership(context, businessId, permission)) !== undefined;
}
