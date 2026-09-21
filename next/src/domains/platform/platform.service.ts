import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, forbiddenError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as repository from "./platform.repository.js";
import {
  type AdminAlert,
  type AdminAlertRow,
  type AdminAlertsPage,
  type CreatePlatformAdministratorInput,
  type CreateSystemAnnouncementInput,
  type ListAdminAlertsFilter,
  type ListSystemAnnouncementsFilter,
  type PlatformAdministrator,
  type PlatformAdministratorRole,
  type PlatformAdministratorRow,
  type PlatformOperation,
  type SystemAnnouncement,
  type SystemAnnouncementRow,
  type SystemAnnouncementsPage,
  type UpdatePlatformAdministratorInput,
  type UpdateSystemAnnouncementInput,
} from "./platform.types.js";

/** Rank order used for `requireAdministrator`'s minimum-role gate; higher index outranks lower. */
const ROLE_RANK: Record<PlatformAdministratorRole, number> = {
  viewer: 0,
  moderator: 1,
  support: 2,
  finance: 3,
  super_admin: 4,
};

export class PlatformService {
  constructor(private readonly database: Database) {}

  async listAdministrators(operation: PlatformOperation): Promise<PlatformAdministrator[]> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "super_admin");
      return (await repository.listAdministrators(context)).map(toAdministrator);
    });
  }

  async createAdministrator(operation: PlatformOperation, input: CreatePlatformAdministratorInput): Promise<PlatformAdministrator> {
    return this.run(operation, async (context) => {
      const actor = await this.requireAdministrator(context, operation.userId, "super_admin");

      const targetUser = await repository.findAuthUserByEmail(context, input.email);
      if (!targetUser) throw validationError("No account exists for that email yet; the person must sign up before being made an administrator.");

      const existing = await repository.findAdministratorByUserId(context, targetUser.id);
      if (existing) throw conflictError("That user is already a platform administrator.");

      const created = await repository.createAdministrator(context, targetUser.id, actor.id, {
        ...input,
        name: input.name || targetUser.name,
        email: targetUser.email,
      });
      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.admin.create",
        targetType: "platform_administrator",
        targetId: created.id,
        metadata: { role: created.role },
        requestId: operation.requestId,
      });
      return toAdministrator(created);
    });
  }

  async updateAdministrator(operation: PlatformOperation, administratorId: string, input: UpdatePlatformAdministratorInput): Promise<PlatformAdministrator> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "super_admin");
      const existing = await repository.findAdministratorById(context, administratorId);
      if (!existing) throw notFoundError("Platform administrator not found");

      const updated = await repository.updateAdministrator(context, administratorId, input);
      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.admin.update",
        targetType: "platform_administrator",
        targetId: administratorId,
        metadata: { ...input },
        requestId: operation.requestId,
      });
      return toAdministrator(updated!);
    });
  }

  async deactivateAdministrator(operation: PlatformOperation, administratorId: string): Promise<void> {
    return this.run(operation, async (context) => {
      const actor = await this.requireAdministrator(context, operation.userId, "super_admin");
      if (actor.id === administratorId) throw validationError("You cannot deactivate your own administrator account.");

      const existing = await repository.findAdministratorById(context, administratorId);
      if (!existing) throw notFoundError("Platform administrator not found");

      await repository.updateAdministrator(context, administratorId, { isActive: false });
      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.admin.deactivate",
        targetType: "platform_administrator",
        targetId: administratorId,
        requestId: operation.requestId,
      });
    });
  }

  async listAlerts(operation: PlatformOperation, filter: ListAdminAlertsFilter): Promise<AdminAlertsPage> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "viewer");
      const [{ rows, total }, unread] = await Promise.all([repository.listAlerts(context, filter), repository.countUnreadAlerts(context)]);
      return { data: rows.map(toAlert), total, unread };
    });
  }

  async unreadAlertCount(operation: PlatformOperation): Promise<number> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "viewer");
      return repository.countUnreadAlerts(context);
    });
  }

  async markAlertsRead(operation: PlatformOperation, alertIds: string[] | undefined): Promise<void> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "viewer");
      await repository.markAlertsRead(context, alertIds);
    });
  }

  async listAnnouncements(operation: PlatformOperation, filter: ListSystemAnnouncementsFilter): Promise<SystemAnnouncementsPage> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "support");
      const { rows, total } = await repository.listAnnouncements(context, filter);
      return { data: rows.map(toAnnouncement), total };
    });
  }

  async createAnnouncement(operation: PlatformOperation, input: CreateSystemAnnouncementInput): Promise<SystemAnnouncement> {
    return this.run(operation, async (context) => {
      const actor = await this.requireAdministrator(context, operation.userId, "support");
      const created = await repository.createAnnouncement(context, actor.id, input);
      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.announcement.create",
        targetType: "system_announcement",
        targetId: created.id,
        requestId: operation.requestId,
      });
      return toAnnouncement(created);
    });
  }

  async updateAnnouncement(operation: PlatformOperation, announcementId: string, input: UpdateSystemAnnouncementInput): Promise<SystemAnnouncement> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "support");
      const existing = await repository.findAnnouncementById(context, announcementId);
      if (!existing) throw notFoundError("Announcement not found");

      const updated = await repository.updateAnnouncement(context, announcementId, input);
      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.announcement.update",
        targetType: "system_announcement",
        targetId: announcementId,
        requestId: operation.requestId,
      });
      return toAnnouncement(updated!);
    });
  }

  async deleteAnnouncement(operation: PlatformOperation, announcementId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await this.requireAdministrator(context, operation.userId, "support");
      const deleted = await repository.deleteAnnouncement(context, announcementId);
      if (!deleted) throw notFoundError("Announcement not found");

      await auditRepository.log(context, {
        businessId: null,
        actorUserId: operation.userId,
        action: "platform.announcement.delete",
        targetType: "system_announcement",
        targetId: announcementId,
        requestId: operation.requestId,
      });
    });
  }

  /**
   * Platform-admin authorization is independent of any business role - it
   * never resolves through app.business_memberships. There is no
   * self-service path to becoming a platform administrator; the first one is
   * granted out-of-band (see db/bootstrap-platform-admin.ts).
   */
  private async requireAdministrator(context: DatabaseContext, userId: string, minimumRole: PlatformAdministratorRole): Promise<PlatformAdministratorRow> {
    const administrator = await repository.findAdministratorByUserId(context, userId);
    if (!administrator || !administrator.isActive) throw forbiddenError("Platform administrator access required");
    if (ROLE_RANK[administrator.role] < ROLE_RANK[minimumRole]) {
      throw forbiddenError(`Requires the ${minimumRole} role or higher`);
    }
    return administrator;
  }

  private async run<T>(operation: PlatformOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toAdministrator(row: PlatformAdministratorRow): PlatformAdministrator {
  return {
    ...row,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toAlert(row: AdminAlertRow): AdminAlert {
  return { ...row, readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

function toAnnouncement(row: SystemAnnouncementRow): SystemAnnouncement {
  return {
    ...row,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
