/**
 * Payroll workflows (PROPOSED_TABLE_INVENTORY.md section 11). A run is created
 * as a draft, approved (payroll.manage), then paid: each item's net pay is
 * executed as an app.transfers row (purpose 'payroll') to the employee's
 * beneficiary, and one balanced journal is posted for the successfully paid
 * items. Payroll owns no payout mechanism of its own - it reuses transfers and
 * the accounting ledger.
 */
import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import * as accountingRepository from "../accounting/accounting.repository.js";
import type { TransfersService } from "../transfers/transfers.service.js";
import * as repository from "./payroll.repository.js";
import type {
  CreatePayrollRunInput,
  PayrollItem,
  PayrollItemRow,
  PayrollOperation,
  PayrollRun,
  PayrollRunRow,
  PayrollRunStatus,
} from "./payroll.types.js";

export class PayrollService {
  constructor(
    private readonly database: Database,
    private readonly transfers: TransfersService,
  ) {}

  async createRun(operation: PayrollOperation, input: CreatePayrollRunInput): Promise<PayrollRun> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.manage");

      let gross = 0n;
      let deductions = 0n;
      let net = 0n;
      const computed = input.items.map((item) => {
        if (item.deductionsMinor > item.grossMinor) throw validationError("deductionsMinor cannot exceed grossMinor");
        const itemNet = item.grossMinor - item.deductionsMinor;
        if (itemNet <= 0n) throw validationError("net pay must be greater than zero");
        gross += item.grossMinor;
        deductions += item.deductionsMinor;
        net += itemNet;
        return { ...item, netMinor: itemNet };
      });

      const runId = randomUUID();
      const run = await repository.insertRun(context, operation.businessId, operation.userId, {
        id: runId,
        reference: `pr_${randomUUID()}`,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        grossMinor: gross.toString(),
        deductionsMinor: deductions.toString(),
        netMinor: net.toString(),
      });

      for (const item of computed) {
        await repository.insertItem(context, operation.businessId, {
          payrollRunId: runId,
          beneficiaryId: item.beneficiaryId,
          partyId: item.partyId ?? null,
          grossMinor: item.grossMinor.toString(),
          deductionsMinor: item.deductionsMinor.toString(),
          netMinor: item.netMinor.toString(),
        });
      }

      return this.hydrate(context, operation.businessId, run);
    });
  }

  async listRuns(operation: PayrollOperation, status: PayrollRunStatus | undefined, limit: number): Promise<PayrollRun[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.read");
      const runs = await repository.listRuns(context, operation.businessId, status, limit);
      return Promise.all(runs.map((run) => this.hydrate(context, operation.businessId, run)));
    });
  }

  async getRun(operation: PayrollOperation, runId: string): Promise<PayrollRun> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.read");
      const run = await this.requireRun(context, operation.businessId, runId);
      return this.hydrate(context, operation.businessId, run);
    });
  }

  async approveRun(operation: PayrollOperation, runId: string): Promise<PayrollRun> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.manage");
      const run = await this.requireRun(context, operation.businessId, runId);
      if (run.status !== "draft") throw conflictError(`Only a draft run can be approved (current: ${run.status})`);
      const updated = await repository.updateRun(context, operation.businessId, runId, { status: "approved", approvedBy: operation.userId, approvedAt: new Date() });
      return this.hydrate(context, operation.businessId, updated!);
    });
  }

  async cancelRun(operation: PayrollOperation, runId: string): Promise<PayrollRun> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.manage");
      const run = await this.requireRun(context, operation.businessId, runId);
      if (run.status !== "draft" && run.status !== "approved") throw conflictError(`Cannot cancel a run in status ${run.status}`);
      const updated = await repository.updateRun(context, operation.businessId, runId, { status: "cancelled" });
      return this.hydrate(context, operation.businessId, updated!);
    });
  }

  /**
   * Pays an approved run. Structured as read -> transfers -> finalize so each
   * transfer runs in its own transaction (no nested DatabaseContext) and a
   * retry is idempotent: every item's transfer idempotency key is derived
   * from the item id, and already-paid items are skipped.
   */
  async payRun(operation: PayrollOperation, runId: string): Promise<PayrollRun> {
    const { run, items } = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "payroll.manage");
      const loaded = await this.requireRun(context, operation.businessId, runId);
      // "paid" is allowed so a retried pay is an idempotent no-op (every item
      // is already paid, its transfer idempotency-key dedupes, and the journal
      // is already posted) rather than a 409.
      if (!["approved", "processing", "partially_paid", "paid"].includes(loaded.status)) {
        throw conflictError(`Only an approved run can be paid (current: ${loaded.status})`);
      }
      const runItems = await repository.listItems(context, operation.businessId, runId);
      return { run: loaded, items: runItems };
    });

    // Execute each unpaid item's net pay as a transfer (own transaction each).
    const results = new Map<string, { transferId: string; paid: boolean }>();
    for (const item of items) {
      if (item.status === "paid") continue;
      const transfer = await this.transfers.requestTransfer(operation, {
        beneficiaryId: item.beneficiaryId,
        amountMinor: BigInt(item.netMinor),
        purpose: "payroll",
        idempotencyKey: `payroll:${item.id}`,
        reason: `Payroll ${run.reference}`,
      });
      results.set(item.id, { transferId: transfer.id, paid: transfer.status === "success" });
    }

    // Finalize: record item outcomes, post one journal for the paid items,
    // and set the run's terminal status.
    return this.run(operation, async (context) => {
      const runItems = await repository.listItems(context, operation.businessId, runId);
      let paidGross = 0n;
      let paidDeductions = 0n;
      let paidNet = 0n;
      let paidCount = 0;

      for (const item of runItems) {
        const result = results.get(item.id);
        if (result) {
          await repository.updateItem(context, operation.businessId, item.id, { status: result.paid ? "paid" : "failed", transferId: result.transferId });
        }
        if (result?.paid || item.status === "paid") {
          paidGross += BigInt(item.grossMinor);
          paidDeductions += BigInt(item.deductionsMinor);
          paidNet += BigInt(item.netMinor);
          paidCount += 1;
        }
      }

      const current = await this.requireRun(context, operation.businessId, runId);
      let journalEntryId = current.journalEntryId ?? undefined;
      if (paidNet > 0n && !current.journalEntryId) {
        const lines = [
          { accountCode: LEDGER_ACCOUNT_CODES.PAYROLL_EXPENSE, direction: "debit" as const, amountMinor: paidGross.toString(), assetCode: current.assetCode },
          { accountCode: LEDGER_ACCOUNT_CODES.BANK, direction: "credit" as const, amountMinor: paidNet.toString(), assetCode: current.assetCode },
          ...(paidDeductions > 0n
            ? [{ accountCode: LEDGER_ACCOUNT_CODES.TAX_PAYABLE, direction: "credit" as const, amountMinor: paidDeductions.toString(), assetCode: current.assetCode }]
            : []),
        ];
        journalEntryId = await accountingRepository.postJournalEntry(
          context,
          operation.businessId,
          operation.userId,
          new Date(),
          `Payroll run ${current.reference}`,
          "payroll_run",
          runId,
          null,
          lines,
        );
      }

      const status: PayrollRunStatus = paidCount === runItems.length ? "paid" : paidCount === 0 ? "processing" : "partially_paid";
      const updated = await repository.updateRun(context, operation.businessId, runId, { status, journalEntryId });
      return this.hydrate(context, operation.businessId, updated!);
    });
  }

  private async requireRun(context: DatabaseContext, businessId: string, runId: string): Promise<PayrollRunRow> {
    const run = await repository.findRun(context, businessId, runId);
    if (!run) throw notFoundError("Payroll run not found");
    return run;
  }

  private async hydrate(context: DatabaseContext, businessId: string, run: PayrollRunRow): Promise<PayrollRun> {
    const items = await repository.listItems(context, businessId, run.id);
    return toRun(run, items);
  }

  private async run<T>(operation: PayrollOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toItem(row: PayrollItemRow): PayrollItem {
  return {
    id: row.id,
    beneficiaryId: row.beneficiaryId,
    partyId: row.partyId,
    grossMinor: row.grossMinor,
    deductionsMinor: row.deductionsMinor,
    netMinor: row.netMinor,
    transferId: row.transferId,
    status: row.status,
  };
}

function toRun(row: PayrollRunRow, items: readonly PayrollItemRow[]): PayrollRun {
  return {
    id: row.id,
    reference: row.reference,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    status: row.status,
    assetCode: row.assetCode,
    grossMinor: row.grossMinor,
    deductionsMinor: row.deductionsMinor,
    netMinor: row.netMinor,
    journalEntryId: row.journalEntryId,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    items: items.map(toItem),
  };
}
