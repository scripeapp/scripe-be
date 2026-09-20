import type { DatabaseContext } from "../../db/database-context.js";
import { forbiddenError } from "../../shared/errors.js";
import * as repository from "./authorization.repository.js";

/**
 * Throws FORBIDDEN when the current membership lacks the permission. This is the
 * shared guard every domain service should call instead of duplicating a permission
 * check against its own repository.
 */
export async function requirePermission(
  context: DatabaseContext,
  businessId: string,
  permission: string,
): Promise<void> {
  if (!(await repository.hasPermission(context, businessId, permission))) {
    throw forbiddenError(`Missing permission: ${permission}`);
  }
}

/**
 * Same guard as requirePermission, for workflows that also need to attribute the
 * action to the membership that performed it (e.g. who opened a register shift).
 */
export async function requireAuthorizedMembership(
  context: DatabaseContext,
  businessId: string,
  permission: string,
): Promise<string> {
  const membershipId = await repository.findAuthorizedMembership(context, businessId, permission);
  if (!membershipId) throw forbiddenError(`Missing permission: ${permission}`);
  return membershipId;
}
