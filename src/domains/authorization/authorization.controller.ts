import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import * as schemas from "./authorization.schemas.js";
import type { AuthorizationService } from "./authorization.service.js";
import type { AuthorizationOperation } from "./authorization.types.js";

export class AuthorizationController {
  constructor(private readonly service: AuthorizationService) {}

  readonly listMembers = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      members: await this.service.listMembers(
        this.operation(request, businessId),
      ),
    };
  });

  readonly getMyMembership = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      membership: await this.service.getMyMembership(
        this.operation(request, businessId),
      ),
    };
  });

  readonly setMemberRoles = this.handle(async (request) => {
    const { businessId, membershipId } = schemas.membershipParamsSchema.parse(
      request.params,
    );
    return {
      membership: await this.service.setMemberRoles(
        this.operation(request, businessId),
        membershipId,
        schemas.setMemberRolesSchema.parse(request.body),
      ),
    };
  });

  readonly removeMember = this.handle(async (request) => {
    const { businessId, membershipId } = schemas.membershipParamsSchema.parse(
      request.params,
    );
    await this.service.removeMember(
      this.operation(request, businessId),
      membershipId,
    );
    return { removed: true };
  });

  readonly inviteMembers = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      results: await this.service.inviteMembers(
        this.operation(request, businessId),
        schemas.inviteMembersSchema.parse(request.body),
      ),
    };
  }, 201);

  readonly listPendingInvitations = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      invitations: await this.service.listPendingInvitations(
        this.operation(request, businessId),
      ),
    };
  });

  readonly revokeInvitation = this.handle(async (request) => {
    const { businessId, invitationId } = schemas.invitationParamsSchema.parse(
      request.params,
    );
    await this.service.revokeInvitation(
      this.operation(request, businessId),
      invitationId,
    );
    return { revoked: true };
  });

  readonly acceptInvitation = this.handle(async (request) => {
    const { token } = schemas.acceptInvitationParamsSchema.parse(
      request.params,
    );
    return {
      accepted: await this.service.acceptInvitation(
        {
          userId: requireAuthContext(request).userId,
          requestId: request.requestId,
        },
        token,
      ),
    };
  }, 201);

  readonly listRoles = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      roles: await this.service.listRoles(this.operation(request, businessId)),
    };
  });

  readonly getRole = this.handle(async (request) => {
    const { businessId, roleId } = schemas.roleParamsSchema.parse(
      request.params,
    );
    return {
      role: await this.service.getRole(
        this.operation(request, businessId),
        roleId,
      ),
    };
  });

  readonly createRole = this.handle(async (request) => {
    const { businessId } = schemas.businessParamsSchema.parse(request.params);
    return {
      role: await this.service.createRole(
        this.operation(request, businessId),
        schemas.createRoleSchema.parse(request.body),
      ),
    };
  }, 201);

  readonly updateRole = this.handle(async (request) => {
    const { businessId, roleId } = schemas.roleParamsSchema.parse(
      request.params,
    );
    return {
      role: await this.service.updateRole(
        this.operation(request, businessId),
        roleId,
        schemas.updateRoleSchema.parse(request.body),
      ),
    };
  });

  readonly deleteRole = this.handle(async (request) => {
    const { businessId, roleId } = schemas.roleParamsSchema.parse(
      request.params,
    );
    await this.service.deleteRole(this.operation(request, businessId), roleId);
    return { deleted: true };
  });

  readonly listPermissions = this.handle(async (request) => ({
    permissions: await this.service.listPermissions({
      userId: requireAuthContext(request).userId,
      requestId: request.requestId,
    }),
  }));

  private operation(
    request: Request,
    businessId: string,
  ): AuthorizationOperation {
    return {
      userId: requireAuthContext(request).userId,
      businessId,
      requestId: request.requestId,
    };
  }

  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) {
    return async (
      request: Request,
      response: Response,
      next: NextFunction,
    ): Promise<void> => {
      try {
        ApiResponse.success(response, await work(request), statusCode);
      } catch (error) {
        next(error);
      }
    };
  }
}
