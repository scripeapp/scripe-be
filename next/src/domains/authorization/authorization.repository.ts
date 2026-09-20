import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  InvitationRow,
  MembershipStatus,
  PermissionRow,
  RoleRow,
  RoleSummary,
} from "./authorization.types.js";

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

// ============================================================================
// Members
// ============================================================================

export interface MembershipAggregateRow {
  readonly id: string;
  readonly businessId: string;
  readonly userId: string;
  readonly email: string;
  readonly status: MembershipStatus;
  readonly roles: RoleSummary[];
  readonly permissionCodes: string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
}

const MEMBERSHIP_AGGREGATE_SELECT = sql`
  select
    membership."id", membership."businessId", membership."userId", "user"."email", membership."status",
    coalesce(roles_agg."roles", '[]') as "roles",
    coalesce(perms_agg."codes", '{}') as "permissionCodes",
    membership."createdAt", membership."updatedAt", membership."endedAt"
  from app.business_memberships membership
  join auth.user "user" on "user"."id" = membership."userId"
  left join lateral (
    select json_agg(json_build_object('id', role."id", 'code', role."code", 'name', role."name")) as "roles"
    from app.membership_roles membership_role
    join app.roles role on role."id" = membership_role."roleId"
    where membership_role."membershipId" = membership."id"
  ) roles_agg on true
  left join lateral (
    select array_agg(distinct permission."code") as "codes"
    from app.membership_roles membership_role
    join app.role_permissions role_permission on role_permission."roleId" = membership_role."roleId"
    join app.permissions permission on permission."id" = role_permission."permissionId"
    where membership_role."membershipId" = membership."id"
  ) perms_agg on true
`;

export async function listMembers(context: DatabaseContext, businessId: string): Promise<MembershipAggregateRow[]> {
  const result = await sql<MembershipAggregateRow>`
    ${MEMBERSHIP_AGGREGATE_SELECT}
    where membership."businessId" = ${businessId}::uuid
    order by membership."createdAt" asc
  `.execute(context.transaction);
  return result.rows;
}

export async function findMembership(context: DatabaseContext, businessId: string, membershipId: string): Promise<MembershipAggregateRow | undefined> {
  const result = await sql<MembershipAggregateRow>`
    ${MEMBERSHIP_AGGREGATE_SELECT}
    where membership."businessId" = ${businessId}::uuid and membership."id" = ${membershipId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findMembershipByUserId(context: DatabaseContext, businessId: string, userId: string): Promise<MembershipAggregateRow | undefined> {
  const result = await sql<MembershipAggregateRow>`
    ${MEMBERSHIP_AGGREGATE_SELECT}
    where membership."businessId" = ${businessId}::uuid and membership."userId" = ${userId}::uuid
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findMembershipRoleCodes(context: DatabaseContext, businessId: string, membershipId: string): Promise<string[]> {
  const result = await sql<{ code: string }>`
    select role."code" from app.membership_roles membership_role
    join app.roles role on role."id" = membership_role."roleId"
    where membership_role."membershipId" = ${membershipId}::uuid and membership_role."businessId" = ${businessId}::uuid
  `.execute(context.transaction);
  return result.rows.map((row) => row.code);
}

export async function setMembershipRoles(context: DatabaseContext, businessId: string, membershipId: string, roleIds: readonly string[]): Promise<void> {
  await sql`delete from app.membership_roles where "membershipId" = ${membershipId}::uuid and "businessId" = ${businessId}::uuid`.execute(context.transaction);
  if (roleIds.length === 0) return;
  await sql`
    insert into app.membership_roles ("membershipId", "businessId", "roleId")
    select ${membershipId}::uuid, ${businessId}::uuid, value::uuid
    from jsonb_array_elements_text(${JSON.stringify(roleIds)}::jsonb) value
  `.execute(context.transaction);
}

export async function endMembership(context: DatabaseContext, businessId: string, membershipId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.business_memberships set "status" = 'ended', "endedAt" = now()
    where "id" = ${membershipId}::uuid and "businessId" = ${businessId}::uuid and "status" <> 'ended'
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

// ============================================================================
// Roles
// ============================================================================

export interface RoleAggregateRow extends RoleRow {
  readonly permissions: PermissionRow[];
}

const ROLE_AGGREGATE_SELECT = sql`
  select
    role."id", role."businessId", role."code", role."name", role."isSystem", role."createdAt",
    coalesce(perm_agg."permissions", '[]') as "permissions"
  from app.roles role
  left join lateral (
    select json_agg(json_build_object('id', permission."id", 'code', permission."code", 'description', permission."description") order by permission."code") as "permissions"
    from app.role_permissions role_permission
    join app.permissions permission on permission."id" = role_permission."permissionId"
    where role_permission."roleId" = role."id"
  ) perm_agg on true
`;

export async function listRoles(context: DatabaseContext, businessId: string): Promise<RoleAggregateRow[]> {
  const result = await sql<RoleAggregateRow>`
    ${ROLE_AGGREGATE_SELECT}
    where role."businessId" is null or role."businessId" = ${businessId}::uuid
    order by role."isSystem" desc, role."name"
  `.execute(context.transaction);
  return result.rows;
}

export async function findRole(context: DatabaseContext, businessId: string, roleId: string): Promise<RoleAggregateRow | undefined> {
  const result = await sql<RoleAggregateRow>`
    ${ROLE_AGGREGATE_SELECT}
    where role."id" = ${roleId}::uuid and (role."businessId" is null or role."businessId" = ${businessId}::uuid)
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findCustomRole(context: DatabaseContext, businessId: string, roleId: string): Promise<RoleRow | undefined> {
  const result = await sql<RoleRow>`
    select "id", "businessId", "code", "name", "isSystem", "createdAt" from app.roles
    where "id" = ${roleId}::uuid and "businessId" = ${businessId}::uuid and not "isSystem"
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

/** Resolves the subset of roleIds that exist and are usable by this business (system or own). */
export async function resolveAssignableRoles(context: DatabaseContext, businessId: string, roleIds: readonly string[]): Promise<RoleRow[]> {
  if (roleIds.length === 0) return [];
  const result = await sql<RoleRow>`
    select "id", "businessId", "code", "name", "isSystem", "createdAt" from app.roles
    where "id" in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(roleIds)}::jsonb) value)
      and ("businessId" is null or "businessId" = ${businessId}::uuid)
  `.execute(context.transaction);
  return result.rows;
}

export async function resolvePermissionIds(context: DatabaseContext, permissionIds: readonly string[]): Promise<string[]> {
  if (permissionIds.length === 0) return [];
  const result = await sql<{ id: string }>`
    select "id" from app.permissions
    where "id" in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(permissionIds)}::jsonb) value)
  `.execute(context.transaction);
  return result.rows.map((row) => row.id);
}

export async function createRole(context: DatabaseContext, businessId: string, code: string, name: string): Promise<RoleRow> {
  const result = await sql<RoleRow>`
    insert into app.roles ("businessId", "code", "name", "isSystem")
    values (${businessId}::uuid, ${code}, ${name}, false)
    returning "id", "businessId", "code", "name", "isSystem", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateRoleName(context: DatabaseContext, roleId: string, name: string): Promise<void> {
  await sql`update app.roles set "name" = ${name} where "id" = ${roleId}::uuid`.execute(context.transaction);
}

export async function setRolePermissions(context: DatabaseContext, roleId: string, permissionIds: readonly string[]): Promise<void> {
  await sql`delete from app.role_permissions where "roleId" = ${roleId}::uuid`.execute(context.transaction);
  if (permissionIds.length === 0) return;
  await sql`
    insert into app.role_permissions ("roleId", "permissionId")
    select ${roleId}::uuid, value::uuid
    from jsonb_array_elements_text(${JSON.stringify(permissionIds)}::jsonb) value
  `.execute(context.transaction);
}

export async function roleInUse(context: DatabaseContext, roleId: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`select exists(select 1 from app.membership_roles where "roleId" = ${roleId}::uuid) as "exists"`.execute(context.transaction);
  return result.rows[0]?.exists === true;
}

export async function deleteRole(context: DatabaseContext, roleId: string): Promise<void> {
  await sql`delete from app.roles where "id" = ${roleId}::uuid`.execute(context.transaction);
}

// ============================================================================
// Permissions
// ============================================================================

export async function listPermissions(context: DatabaseContext): Promise<PermissionRow[]> {
  const result = await sql<PermissionRow>`select "id", "code", "description" from app.permissions order by "code"`.execute(context.transaction);
  return result.rows;
}

// ============================================================================
// Invitations
// ============================================================================

export async function findUserName(context: DatabaseContext, userId: string): Promise<string | undefined> {
  const result = await sql<{ name: string }>`select "name" from auth.user where "id" = ${userId}::uuid`.execute(context.transaction);
  return result.rows[0]?.name;
}

export async function findPendingInvitationByEmail(context: DatabaseContext, businessId: string, email: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    select "id" from app.business_invitations
    where "businessId" = ${businessId}::uuid and "email" = ${email}
      and "acceptedAt" is null and "revokedAt" is null and "expiresAt" > now()
    limit 1
  `.execute(context.transaction);
  return result.rows.length > 0;
}

export async function findActiveMembershipByEmail(context: DatabaseContext, businessId: string, email: string): Promise<string | undefined> {
  const result = await sql<{ id: string }>`
    select membership."id" from app.business_memberships membership
    join auth.user "user" on "user"."id" = membership."userId"
    where membership."businessId" = ${businessId}::uuid and lower("user"."email") = ${email} and membership."status" = 'active'
    limit 1
  `.execute(context.transaction);
  return result.rows[0]?.id;
}

export async function createInvitation(
  context: DatabaseContext,
  businessId: string,
  invitedBy: string,
  email: string,
  roleId: string,
  tokenHash: string,
  expiresAt: Date,
): Promise<InvitationRow> {
  const result = await sql<InvitationRow>`
    insert into app.business_invitations ("businessId", "email", "roleId", "tokenHash", "invitedBy", "expiresAt")
    values (${businessId}::uuid, ${email}, ${roleId}::uuid, ${tokenHash}, ${invitedBy}::uuid, ${expiresAt.toISOString()}::timestamptz)
    returning "id", "businessId", "email", "roleId", "invitedBy", "expiresAt", "createdAt"
  `.execute(context.transaction);
  return result.rows[0]!;
}

export interface PendingInvitationRow extends InvitationRow {
  readonly roleCode: string;
  readonly roleName: string;
}

export async function listPendingInvitations(context: DatabaseContext, businessId: string): Promise<PendingInvitationRow[]> {
  const result = await sql<PendingInvitationRow>`
    select
      invitation."id", invitation."businessId", invitation."email", invitation."roleId",
      invitation."invitedBy", invitation."expiresAt", invitation."createdAt",
      role."code" as "roleCode", role."name" as "roleName"
    from app.business_invitations invitation
    join app.roles role on role."id" = invitation."roleId"
    where invitation."businessId" = ${businessId}::uuid
      and invitation."acceptedAt" is null and invitation."revokedAt" is null and invitation."expiresAt" > now()
    order by invitation."createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function revokeInvitation(context: DatabaseContext, businessId: string, invitationId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.business_invitations set "revokedAt" = now()
    where "id" = ${invitationId}::uuid and "businessId" = ${businessId}::uuid
      and "acceptedAt" is null and "revokedAt" is null
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

export interface AcceptedInvitation {
  readonly membershipId: string;
  readonly businessId: string;
  readonly roleId: string;
}

/**
 * The accepting user is not yet a member of the target business, so no
 * has_business_permission check can gate this — possession of the token is
 * the authorization. Delegates to the accept_business_invitation security
 * definer function (see migration 0019) rather than inserting directly.
 */
export async function acceptInvitation(context: DatabaseContext, tokenHash: string): Promise<AcceptedInvitation | undefined> {
  const result = await sql<AcceptedInvitation>`select * from app.accept_business_invitation(${tokenHash})`.execute(context.transaction);
  return result.rows[0]?.membershipId ? result.rows[0] : undefined;
}
