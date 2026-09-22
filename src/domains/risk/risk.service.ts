import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError } from "../../shared/errors.js";
import { requirePlatformAdministrator } from "../platform/platform.service.js";
import * as repository from "./risk.repository.js";
import type {
  CreateCaseInput,
  CreateHoldInput,
  HoldEntityType,
  ListSignalsFilter,
  ReviewSignalInput,
  RiskCase,
  RiskCaseRow,
  RiskOperation,
  RiskSignal,
  RiskSignalRow,
  RiskStats,
  SignalsPage,
  TransactionHold,
  TransactionHoldRow,
  UpdateCaseInput,
} from "./risk.types.js";

export class RiskService {
  constructor(private readonly database: Database) {}

  async listSignals(operation: RiskOperation, filter: ListSignalsFilter): Promise<SignalsPage> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      const { rows, total } = await repository.listSignals(context, filter);
      return { data: rows.map(toSignal), total };
    });
  }

  async getStats(operation: RiskOperation): Promise<RiskStats> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      return repository.getStats(context);
    });
  }

  async reviewSignal(operation: RiskOperation, signalId: string, input: ReviewSignalInput): Promise<RiskSignal> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const existing = await repository.findSignal(context, signalId);
      if (!existing) throw notFoundError("Signal not found");
      const updated = await repository.reviewSignal(context, signalId, operation.userId, input);
      return toSignal(updated!);
    });
  }

  async listCases(operation: RiskOperation, status: string | undefined): Promise<RiskCase[]> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      return (await repository.listCases(context, status)).map(toCase);
    });
  }

  async getCase(operation: RiskOperation, caseId: string): Promise<{ case: RiskCase; signals: RiskSignal[] }> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      const found = await repository.findCase(context, caseId);
      if (!found) throw notFoundError("Case not found");
      const signals = await repository.listSignalsForCase(context, caseId);
      return { case: toCase(found), signals: signals.map(toSignal) };
    });
  }

  async createCase(operation: RiskOperation, input: CreateCaseInput): Promise<RiskCase> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const created = await repository.createCase(context, operation.userId, input);
      if (input.signalIds && input.signalIds.length > 0) {
        await repository.assignSignalsToCase(context, created.id, input.signalIds);
      }
      return toCase(created);
    });
  }

  async updateCase(operation: RiskOperation, caseId: string, input: UpdateCaseInput): Promise<RiskCase> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const existing = await repository.findCase(context, caseId);
      if (!existing) throw notFoundError("Case not found");
      const updated = await repository.updateCase(context, caseId, input);
      return toCase(updated!);
    });
  }

  async listHolds(operation: RiskOperation, status: string | undefined): Promise<TransactionHold[]> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "viewer");
      return (await repository.listHolds(context, status)).map(toHold);
    });
  }

  async createHold(operation: RiskOperation, input: CreateHoldInput): Promise<TransactionHold> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const created = await repository.createHold(context, operation.userId, input);
      return toHold(created);
    });
  }

  async releaseHold(operation: RiskOperation, holdId: string): Promise<TransactionHold> {
    return this.run(operation, async (context) => {
      await requirePlatformAdministrator(context, operation.userId, "support");
      const existing = await repository.findHold(context, holdId);
      if (!existing) throw notFoundError("Hold not found");
      if (existing.status !== "active") throw conflictError("This hold has already been released");
      const released = await repository.releaseHold(context, holdId, operation.userId);
      return toHold(released!);
    });
  }

  private async run<T>(operation: RiskOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * Reusable by other domains (e.g. banking's withdrawal gate) to check for an
 * active hold before proceeding with a real money-movement action - the
 * same "exported standalone function, not a class method" shape as
 * requirePlatformAdministrator and authorization's requirePermission.
 */
export async function hasActiveHold(context: DatabaseContext, entityType: HoldEntityType, entityId: string): Promise<boolean> {
  return repository.hasActiveHold(context, entityType, entityId);
}

/**
 * Reusable by other domains' service code to raise a fraud/anomaly signal
 * within their own transaction. Fire-and-forget by design (matching
 * legacy's original, never-wired recordSignal): a caller should not let a
 * signal-recording failure abort the real action it's describing, so this
 * swallows its own errors rather than propagating them.
 */
export async function recordSignal(
  context: DatabaseContext,
  input: Parameters<typeof repository.recordSignal>[1],
): Promise<void> {
  try {
    await repository.recordSignal(context, input);
  } catch (error) {
    console.error("[risk] recordSignal failed", error);
  }
}

function toSignal(row: RiskSignalRow): RiskSignal {
  return { ...row, reviewedAt: row.reviewedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}

function toCase(row: RiskCaseRow): RiskCase {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), resolvedAt: row.resolvedAt?.toISOString() ?? null };
}

function toHold(row: TransactionHoldRow): TransactionHold {
  return { ...row, releasedAt: row.releasedAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
}
