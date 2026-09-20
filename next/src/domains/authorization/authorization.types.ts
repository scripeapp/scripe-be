export type MembershipStatus = "invited" | "active" | "suspended" | "ended";

export interface RoleSummary {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface MembershipRow {
  readonly id: string;
  readonly businessId: string;
  readonly userId: string;
  readonly email: string;
  readonly status: MembershipStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly endedAt: Date | null;
}

export interface Membership {
  readonly id: string;
  readonly businessId: string;
  readonly userId: string;
  readonly email: string;
  readonly status: MembershipStatus;
  readonly roles: RoleSummary[];
  readonly permissionCodes: string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt: string | null;
}

export interface PermissionRow {
  readonly id: string;
  readonly code: string;
  readonly description: string;
}

/** Category is derived from the code prefix (e.g. "store.read" -> "store"); it is not a stored column. */
export interface Permission extends PermissionRow {
  readonly category: string;
}

export interface RoleRow {
  readonly id: string;
  readonly businessId: string | null;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly createdAt: Date;
}

export interface Role {
  readonly id: string;
  readonly businessId: string | null;
  readonly code: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly createdAt: string;
  readonly permissions: Permission[];
}

export interface InvitationRow {
  readonly id: string;
  readonly businessId: string;
  readonly email: string;
  readonly roleId: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface Invitation {
  readonly id: string;
  readonly businessId: string;
  readonly email: string;
  readonly role: RoleSummary;
  readonly invitedBy: string;
  readonly expiresAt: string;
  readonly createdAt: string;
}

export interface InviteResult {
  readonly email: string;
  readonly success: boolean;
  readonly invitationId?: string;
  readonly error?: string;
}

export interface AuthorizationOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface AcceptInvitationOperation {
  readonly userId: string;
  readonly requestId: string;
}

export interface InviteMembersInput {
  readonly emails: readonly string[];
  readonly roleId: string;
}

export interface SetMemberRolesInput {
  readonly roleIds: readonly string[];
}

export interface CreateRoleInput {
  readonly name: string;
  readonly permissionIds: readonly string[];
}

export interface UpdateRoleInput {
  readonly name?: string;
  readonly permissionIds?: readonly string[];
}
