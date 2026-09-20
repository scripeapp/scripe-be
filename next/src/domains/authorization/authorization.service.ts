import { randomBytes, createHash } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { emailSender } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import {
  AppError,
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
} from "../../shared/errors.js";
import * as businessesRepository from "../businesses/businesses.repository.js";
import * as repository from "./authorization.repository.js";
import type {
  AcceptInvitationOperation,
  AuthorizationOperation,
  CreateRoleInput,
  InviteMembersInput,
  InviteResult,
  Membership,
  Permission,
  Role,
  SetMemberRolesInput,
  UpdateRoleInput,
} from "./authorization.types.js";

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

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export class AuthorizationService {
  constructor(private readonly database: Database) {}

  async listMembers(operation: AuthorizationOperation): Promise<Membership[]> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.read");
      return (await repository.listMembers(context, operation.businessId)).map(toMembership);
    });
  }

  async getMyMembership(operation: AuthorizationOperation): Promise<Membership> {
    return this.run(operation, operation.businessId, async (context) => {
      const row = await repository.findMembershipByUserId(context, operation.businessId, operation.userId);
      if (!row) throw notFoundError("Membership not found");
      return toMembership(row);
    });
  }

  async setMemberRoles(operation: AuthorizationOperation, membershipId: string, input: SetMemberRolesInput): Promise<Membership> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.manage");
      const target = await repository.findMembership(context, operation.businessId, membershipId);
      if (!target) throw notFoundError("Membership not found");
      if (target.roles.some((role) => role.code === "owner")) throw forbiddenError("Cannot change the owner's roles");

      const uniqueRoleIds = [...new Set(input.roleIds)];
      const resolved = await repository.resolveAssignableRoles(context, operation.businessId, uniqueRoleIds);
      if (resolved.length !== uniqueRoleIds.length) throw validationError("One or more roles do not exist for this business");
      if (resolved.some((role) => role.code === "owner")) throw validationError("The owner role cannot be assigned");

      await repository.setMembershipRoles(context, operation.businessId, membershipId, uniqueRoleIds);
      const updated = await repository.findMembership(context, operation.businessId, membershipId);
      return toMembership(updated!);
    });
  }

  async removeMember(operation: AuthorizationOperation, membershipId: string): Promise<void> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.manage");
      const target = await repository.findMembership(context, operation.businessId, membershipId);
      if (!target) throw notFoundError("Membership not found");
      if (target.roles.some((role) => role.code === "owner")) throw forbiddenError("Cannot remove the owner");
      await repository.endMembership(context, operation.businessId, membershipId);
    });
  }

  async inviteMembers(operation: AuthorizationOperation, input: InviteMembersInput): Promise<InviteResult[]> {
    const setup = await this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.invite");
      const resolvedRoles = await repository.resolveAssignableRoles(context, operation.businessId, [input.roleId]);
      const role = resolvedRoles[0];
      if (!role) throw validationError("Role does not exist for this business");
      if (role.code === "owner") throw validationError("The owner role cannot be assigned");

      const business = await businessesRepository.findBusiness(context, operation.businessId);
      if (!business) throw notFoundError("Business not found");
      const inviterName = (await repository.findUserName(context, operation.userId)) ?? "A team member";
      return { roleId: role.id, businessName: business.displayName, inviterName };
    });

    const frontendUrl = loadEnvironment().FRONTEND_URL;
    const results: InviteResult[] = [];
    for (const rawEmail of input.emails) {
      const email = rawEmail.trim().toLowerCase();
      results.push(await this.inviteOne(operation, setup.roleId, email, setup.businessName, setup.inviterName, frontendUrl));
    }
    return results;
  }

  private async inviteOne(
    operation: AuthorizationOperation,
    roleId: string,
    email: string,
    businessName: string,
    inviterName: string,
    frontendUrl: string,
  ): Promise<InviteResult> {
    try {
      return await this.run(operation, operation.businessId, async (context) => {
        const existingMember = await repository.findActiveMembershipByEmail(context, operation.businessId, email);
        if (existingMember) throw conflictError("User is already a member of this business");
        if (await repository.findPendingInvitationByEmail(context, operation.businessId, email)) {
          throw conflictError("An invitation is already pending for this email");
        }

        const token = randomBytes(32).toString("hex");
        const tokenHash = createHash("sha256").update(token).digest("hex");
        const expiresAt = new Date(Date.now() + INVITATION_TTL_MS);
        const invitation = await repository.createInvitation(context, operation.businessId, operation.userId, email, roleId, tokenHash, expiresAt);

        const acceptUrl = `${frontendUrl}/accept-invite?token=${token}`;
        await emailSender.sendBusinessInvitation(email, { businessName, inviterName, acceptUrl });

        return { email, success: true, invitationId: invitation.id };
      });
    } catch (error) {
      if (error instanceof AppError) return { email, success: false, error: error.message };
      if (error instanceof DatabaseError && error.kind === "unique-violation") {
        return { email, success: false, error: "An invitation is already pending for this email" };
      }
      throw error;
    }
  }

  async acceptInvitation(operation: AcceptInvitationOperation, token: string): Promise<{ businessId: string }> {
    return this.run(operation, null, async (context) => {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const accepted = await repository.acceptInvitation(context, tokenHash);
      if (!accepted) throw notFoundError("Invalid or expired invitation");
      return { businessId: accepted.businessId };
    });
  }

  async listPendingInvitations(operation: AuthorizationOperation) {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.read");
      const rows = await repository.listPendingInvitations(context, operation.businessId);
      return rows.map((row) => ({
        id: row.id,
        businessId: row.businessId,
        email: row.email,
        role: { id: row.roleId, code: row.roleCode, name: row.roleName },
        invitedBy: row.invitedBy,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      }));
    });
  }

  async revokeInvitation(operation: AuthorizationOperation, invitationId: string): Promise<void> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.invite");
      if (!(await repository.revokeInvitation(context, operation.businessId, invitationId))) {
        throw notFoundError("Pending invitation not found");
      }
    });
  }

  async listRoles(operation: AuthorizationOperation): Promise<Role[]> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.read");
      return (await repository.listRoles(context, operation.businessId)).map(toRole);
    });
  }

  async getRole(operation: AuthorizationOperation, roleId: string): Promise<Role> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.read");
      const row = await repository.findRole(context, operation.businessId, roleId);
      if (!row) throw notFoundError("Role not found");
      return toRole(row);
    });
  }

  async createRole(operation: AuthorizationOperation, input: CreateRoleInput): Promise<Role> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.manage");
      const uniquePermissionIds = [...new Set(input.permissionIds)];
      const resolvedPermissionIds = await repository.resolvePermissionIds(context, uniquePermissionIds);
      if (resolvedPermissionIds.length !== uniquePermissionIds.length) throw validationError("One or more permissions do not exist");

      const code = slugify(input.name);
      const role = await repository.createRole(context, operation.businessId, code, input.name);
      if (resolvedPermissionIds.length > 0) await repository.setRolePermissions(context, role.id, resolvedPermissionIds);

      const created = await repository.findRole(context, operation.businessId, role.id);
      return toRole(created!);
    });
  }

  async updateRole(operation: AuthorizationOperation, roleId: string, input: UpdateRoleInput): Promise<Role> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.manage");
      const existing = await repository.findCustomRole(context, operation.businessId, roleId);
      if (!existing) throw notFoundError("Role not found");

      if (input.name !== undefined) await repository.updateRoleName(context, roleId, input.name);
      if (input.permissionIds !== undefined) {
        const uniquePermissionIds = [...new Set(input.permissionIds)];
        const resolvedPermissionIds = await repository.resolvePermissionIds(context, uniquePermissionIds);
        if (resolvedPermissionIds.length !== uniquePermissionIds.length) throw validationError("One or more permissions do not exist");
        await repository.setRolePermissions(context, roleId, resolvedPermissionIds);
      }

      const updated = await repository.findRole(context, operation.businessId, roleId);
      return toRole(updated!);
    });
  }

  async deleteRole(operation: AuthorizationOperation, roleId: string): Promise<void> {
    return this.run(operation, operation.businessId, async (context) => {
      await requirePermission(context, operation.businessId, "team.manage");
      const existing = await repository.findCustomRole(context, operation.businessId, roleId);
      if (!existing) throw notFoundError("Role not found");
      if (await repository.roleInUse(context, roleId)) throw conflictError("Cannot delete a role that is assigned to members");
      await repository.deleteRole(context, roleId);
    });
  }

  async listPermissions(operation: { userId: string; requestId: string }): Promise<Permission[]> {
    return this.run(operation, null, async (context) => (await repository.listPermissions(context)).map(toPermission));
  }

  private async run<T>(
    operation: { userId: string; requestId: string },
    businessId: string | null,
    work: (context: DatabaseContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toMembership(row: Awaited<ReturnType<typeof repository.listMembers>>[number]): Membership {
  return {
    id: row.id,
    businessId: row.businessId,
    userId: row.userId,
    email: row.email,
    status: row.status,
    roles: row.roles,
    permissionCodes: row.permissionCodes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}

function toRole(row: Awaited<ReturnType<typeof repository.listRoles>>[number]): Role {
  return {
    id: row.id,
    businessId: row.businessId,
    code: row.code,
    name: row.name,
    isSystem: row.isSystem,
    createdAt: row.createdAt.toISOString(),
    permissions: row.permissions.map(toPermission),
  };
}

function toPermission(row: Awaited<ReturnType<typeof repository.listPermissions>>[number]): Permission {
  return { ...row, category: row.code.split(".")[0] ?? row.code };
}

function slugify(value: string): string {
  return value.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "role";
}
