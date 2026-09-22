import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import * as repository from "./notifications.repository.js";
import type {
  ListNotificationsFilter,
  Notification,
  NotificationChannel,
  NotificationPreference,
  NotificationPreferenceRow,
  NotificationRow,
  NotificationsOperation,
  UpdateNotificationInput,
} from "./notifications.types.js";

export class NotificationsService {
  constructor(private readonly database: Database) {}

  async list(operation: NotificationsOperation, filter: ListNotificationsFilter): Promise<Notification[]> {
    return this.run(operation, async (context) => (await repository.listForUser(context, operation.userId, filter)).map(toNotification));
  }

  async unreadCount(operation: NotificationsOperation): Promise<number> {
    return this.run(operation, (context) => repository.countUnread(context, operation.userId));
  }

  async update(operation: NotificationsOperation, notificationId: string, input: UpdateNotificationInput): Promise<Notification> {
    return this.run(operation, async (context) => {
      const existing = await repository.findForUser(context, operation.userId, notificationId);
      if (!existing) throw notFoundError("Notification not found");

      const fields: { readAt?: Date | null; archivedAt?: Date | null } = {};
      if (input.read !== undefined) fields.readAt = input.read ? new Date() : null;
      if (input.archived !== undefined) fields.archivedAt = input.archived ? new Date() : null;
      if (Object.keys(fields).length === 0) throw validationError("At least one of read or archived is required");

      const updated = await repository.updateNotification(context, operation.userId, notificationId, fields);
      return toNotification(updated!);
    });
  }

  async listPreferences(operation: NotificationsOperation): Promise<NotificationPreference[]> {
    return this.run(operation, async (context) => (await repository.listPreferences(context, operation.userId)).map(toPreference));
  }

  async setPreference(operation: NotificationsOperation, type: string, channel: NotificationChannel, enabled: boolean): Promise<NotificationPreference> {
    return this.run(operation, async (context) => toPreference(await repository.setPreference(context, operation.userId, type, channel, enabled)));
  }

  private async run<T>(operation: NotificationsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toNotification(row: NotificationRow): Notification {
  return {
    ...row,
    readAt: row.readAt?.toISOString() ?? null,
    archivedAt: row.archivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function toPreference(row: NotificationPreferenceRow): NotificationPreference {
  return { ...row, updatedAt: row.updatedAt.toISOString() };
}
