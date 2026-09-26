import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./dashboard.repository.js";
import type { DashboardStats } from "./dashboard.repository.js";

export interface DashboardOperation {
  readonly userId: string;
  readonly requestId: string;
  readonly businessId: string;
}

export class DashboardService {
  constructor(private readonly database: Database) {}

  async stats(
    operation: DashboardOperation,
    currency: string,
    since: Date | null,
  ): Promise<DashboardStats> {
    return this.run(operation, async (context) => {
      await authorization.requirePermission(context, operation.businessId, "order.read");
      return repo.getStats(context, operation.businessId, currency, since);
    });
  }

  private async run<T>(
    operation: DashboardOperation,
    work: Parameters<typeof withDatabaseContext<T>>[2],
  ): Promise<T> {
    try {
      return await withDatabaseContext(
        this.database,
        withIdentity(operation.requestId, operation.userId, operation.businessId),
        work,
      );
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}
