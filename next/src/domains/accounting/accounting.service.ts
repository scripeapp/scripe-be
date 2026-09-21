/**
 * Business workflows and transaction boundaries for the asset, ledger account, journal,
 * period, rate, and financial reporting domain belong here.
 */
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./accounting.repository.js";
import type {
  AccountingOperation,
  AccountingPeriod,
  AccountingPeriodRow,
  JournalEntry,
  LedgerAccount,
  LedgerAccountCode,
  PostJournalEntryInput,
  TrialBalanceLine,
} from "./accounting.types.js";
import { LEDGER_ACCOUNT_CODES } from "./accounting.types.js";

export async function seedDefaultChartOfAccounts(context: DatabaseContext, businessId: string): Promise<void> {
  await repository.seedDefaultChartOfAccounts(context, businessId);
}

const CATEGORY_ACCOUNT_CODES: Record<string, LedgerAccountCode> = {
  inventory: LEDGER_ACCOUNT_CODES.INVENTORY,
  stock: LEDGER_ACCOUNT_CODES.INVENTORY,
  cogs: LEDGER_ACCOUNT_CODES.COGS,
  "cost of goods sold": LEDGER_ACCOUNT_CODES.COGS,
  rent: LEDGER_ACCOUNT_CODES.RENT_EXPENSE,
  utilities: LEDGER_ACCOUNT_CODES.UTILITIES_EXPENSE,
  utility: LEDGER_ACCOUNT_CODES.UTILITIES_EXPENSE,
  tax: LEDGER_ACCOUNT_CODES.TAX_EXPENSE,
  fee: LEDGER_ACCOUNT_CODES.FEES_EXPENSE,
  fees: LEDGER_ACCOUNT_CODES.FEES_EXPENSE,
};

const BILL_TYPE_ACCOUNT_CODES: Record<string, LedgerAccountCode> = {
  utility: LEDGER_ACCOUNT_CODES.UTILITIES_EXPENSE,
  tax: LEDGER_ACCOUNT_CODES.TAX_EXPENSE,
  rent: LEDGER_ACCOUNT_CODES.RENT_EXPENSE,
};

/**
 * bill_lines.accountCategory is caller-supplied free text with no enum -
 * payables' already-shipped createBill never validated it, so this can't
 * become a hard lookup without risking breaking existing callers. Matched
 * case-insensitively against the known set; a bill's own billType is a
 * second-chance fallback (a "utility" bill with an unrecognized line
 * category still lands on utilities, not the generic bucket); anything
 * else lands on general_expense rather than failing the bill.
 */
export function resolveExpenseAccountCode(accountCategory: string, billType: string): LedgerAccountCode {
  const normalized = accountCategory.trim().toLowerCase();
  return CATEGORY_ACCOUNT_CODES[normalized] ?? BILL_TYPE_ACCOUNT_CODES[billType] ?? LEDGER_ACCOUNT_CODES.GENERAL_EXPENSE;
}

/**
 * The one cross-domain entry point every other domain posts through
 * (payments, returns, payables, inventory) - matching this codebase's
 * standalone-exported-function pattern for cross-domain reuse (checkLimit,
 * hasActiveHold, recordSignal). Runs inside the caller's own transaction:
 * a thrown error here rolls back the caller's own writes right along with
 * it, so a domain event and its journal entry always commit or fail
 * together. Unlike risk's recordSignal, this never swallows its own
 * errors - a payment captured with no journal behind it would be silent
 * accounting drift, which matters more than the extremely rare
 * append-only-write failure this would otherwise protect against.
 */
export async function postJournalEntry(context: DatabaseContext, businessId: string, userId: string | null, input: PostJournalEntryInput): Promise<{ id: string }> {
  if (input.lines.length < 2) throw new Error(`postJournalEntry for ${input.sourceType}:${input.sourceId} needs at least two lines`);

  const balances = new Map<string, bigint>();
  for (const line of input.lines) {
    if (line.amountMinor <= 0n) throw new Error(`postJournalEntry for ${input.sourceType}:${input.sourceId} has a non-positive line amount`);
    const signed = line.direction === "debit" ? line.amountMinor : -line.amountMinor;
    balances.set(line.assetCode, (balances.get(line.assetCode) ?? 0n) + signed);
  }
  for (const [assetCode, balance] of balances) {
    if (balance !== 0n) throw new Error(`postJournalEntry for ${input.sourceType}:${input.sourceId} does not balance for ${assetCode} (off by ${balance})`);
  }

  const entryDate = input.entryDate ?? new Date();
  const lines: repository.PostJournalLine[] = input.lines.map((line) => ({ accountCode: line.accountCode, direction: line.direction, amountMinor: line.amountMinor.toString(), assetCode: line.assetCode }));

  const id = await repository.postJournalEntry(context, businessId, userId, entryDate, input.description, input.sourceType, input.sourceId, input.reversalOfId ?? null, lines);
  return { id };
}

export class AccountingService {
  constructor(private readonly database: Database) {}

  async listLedgerAccounts(operation: AccountingOperation): Promise<LedgerAccount[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.read");
      const rows = await repository.listLedgerAccounts(context, operation.businessId);
      return rows.map((row) => ({ id: row.id, code: row.code, name: row.name, type: row.type, status: row.status }));
    });
  }

  async listJournalEntries(operation: AccountingOperation, limit = 50): Promise<JournalEntry[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.read");
      const entries = await repository.listJournalEntries(context, operation.businessId, limit);
      return Promise.all(entries.map((entry) => this.toJournalEntry(context, operation.businessId, entry)));
    });
  }

  async getJournalEntry(operation: AccountingOperation, journalEntryId: string): Promise<JournalEntry> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.read");
      const entry = await repository.findJournalEntry(context, operation.businessId, journalEntryId);
      if (!entry) throw notFoundError("Journal entry not found");
      return this.toJournalEntry(context, operation.businessId, entry);
    });
  }

  async getTrialBalance(operation: AccountingOperation): Promise<TrialBalanceLine[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.read");
      return repository.getTrialBalance(context, operation.businessId);
    });
  }

  async listPeriods(operation: AccountingOperation): Promise<AccountingPeriod[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.read");
      const rows = await repository.listPeriods(context, operation.businessId);
      return rows.map(toPeriod);
    });
  }

  async setPeriodStatus(operation: AccountingOperation, periodId: string, status: "open" | "closing" | "locked"): Promise<AccountingPeriod> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "accounting.manage");
      const row = await repository.setPeriodStatus(context, operation.businessId, periodId, status);
      if (!row) throw notFoundError("Accounting period not found");
      return toPeriod(row);
    });
  }

  private async toJournalEntry(context: DatabaseContext, businessId: string, entry: Awaited<ReturnType<typeof repository.findJournalEntry>> & object): Promise<JournalEntry> {
    const lines = await repository.listJournalLines(context, businessId, entry.id);
    return {
      id: entry.id,
      entryDate: entry.entryDate.toISOString().slice(0, 10),
      description: entry.description,
      sourceType: entry.sourceType,
      sourceId: entry.sourceId,
      reversalOfId: entry.reversalOfId,
      createdAt: entry.createdAt.toISOString(),
      lines: lines.map((line) => ({ accountCode: line.ledgerAccountCode, accountName: line.ledgerAccountName, direction: line.direction, amountMinor: line.amountMinor, assetCode: line.assetCode })),
    };
  }

  private async run<T>(operation: AccountingOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toPeriod(row: AccountingPeriodRow): AccountingPeriod {
  return { id: row.id, periodStart: row.periodStart.toISOString().slice(0, 10), status: row.status, periodEnd: row.periodEnd.toISOString().slice(0, 10) };
}
