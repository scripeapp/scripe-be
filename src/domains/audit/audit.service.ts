import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import { requirePlatformAdministrator } from "../platform/platform.service.js";
import * as repository from "./audit.repository.js";
import type { AuditEvent, AuditEventRow, AuditOperation, ListAuditEventsFilter } from "./audit.types.js";

export class AuditService {
  constructor(private readonly database: Database) {}

  async list(operation: AuditOperation, filter: ListAuditEventsFilter): Promise<AuditEvent[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "audit.read");
      return (await repository.listForBusiness(context, operation.businessId, filter)).map(toAuditEvent);
    });
  }

  async listAll(userId: string, requestId: string, filter: ListAuditEventsFilter): Promise<AuditEvent[]> {
    return this.run({ userId, businessId: "00000000-0000-0000-0000-000000000000", requestId }, async (context) => {
      await requirePlatformAdministrator(context, userId, "viewer");
      return (await repository.listAll(context, filter)).map(toAuditEvent);
    });
  }

  private async run<T>(operation: AuditOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
