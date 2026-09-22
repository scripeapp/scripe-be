/**
 * Database access for the asset, ledger account, journal, period, rate, and financial
 * reporting domain belongs here. Repository functions must accept DatabaseContext and
 * must not import the global database.
 */
import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { AccountingPeriodRow, JournalEntryRow, JournalLineRow, LedgerAccountRow, LedgerAccountType, TrialBalanceLine } from "./accounting.types.js";
import { LEDGER_ACCOUNT_CODES } from "./accounting.types.js";

const DEFAULT_CHART: readonly { code: string; name: string; type: LedgerAccountType }[] = [
  { code: LEDGER_ACCOUNT_CODES.CASH, name: "Cash", type: "asset" },
  { code: LEDGER_ACCOUNT_CODES.BANK, name: "Bank", type: "asset" },
  { code: LEDGER_ACCOUNT_CODES.GATEWAY_CLEARING, name: "Payment Gateway Clearing", type: "asset" },
  { code: LEDGER_ACCOUNT_CODES.INVENTORY, name: "Inventory", type: "asset" },
  { code: LEDGER_ACCOUNT_CODES.ACCOUNTS_PAYABLE, name: "Accounts Payable", type: "liability" },
  { code: LEDGER_ACCOUNT_CODES.REFUNDS_PAYABLE, name: "Refunds Payable", type: "liability" },
  { code: LEDGER_ACCOUNT_CODES.TAX_PAYABLE, name: "Tax Payable", type: "liability" },
  { code: LEDGER_ACCOUNT_CODES.REVENUE, name: "Sales Revenue", type: "revenue" },
  { code: LEDGER_ACCOUNT_CODES.SALES_RETURNS, name: "Sales Returns & Allowances", type: "revenue" },
  { code: LEDGER_ACCOUNT_CODES.COGS, name: "Cost of Goods Sold", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.WASTE_EXPENSE, name: "Inventory Waste", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.GENERAL_EXPENSE, name: "General Expense", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.RENT_EXPENSE, name: "Rent Expense", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.UTILITIES_EXPENSE, name: "Utilities Expense", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.TAX_EXPENSE, name: "Tax Expense", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.FEES_EXPENSE, name: "Fees & Charges", type: "expense" },
  { code: LEDGER_ACCOUNT_CODES.PAYROLL_EXPENSE, name: "Payroll Expense", type: "expense" },
];

export async function seedDefaultChartOfAccounts(context: DatabaseContext, businessId: string): Promise<void> {
  for (const account of DEFAULT_CHART) {
    await sql`
      insert into app.ledger_accounts ("businessId", "code", "name", "type", "isSystem")
      values (${businessId}::uuid, ${account.code}, ${account.name}, ${account.type}, true)
      on conflict ("businessId", "code") do nothing
    `.execute(context.transaction);
  }
}

export async function listLedgerAccounts(context: DatabaseContext, businessId: string): Promise<LedgerAccountRow[]> {
  const result = await sql<LedgerAccountRow>`
    select "id", "businessId", "code", "name", "type", "isSystem", "status", "createdAt", "updatedAt"
    from app.ledger_accounts where "businessId" = ${businessId}::uuid order by "type", "code"
  `.execute(context.transaction);
  return result.rows;
}

export async function listPeriods(context: DatabaseContext, businessId: string): Promise<AccountingPeriodRow[]> {
  const result = await sql<AccountingPeriodRow>`
    select "id", "businessId", "periodStart", "periodEnd", "status", "closedAt"
    from app.accounting_periods where "businessId" = ${businessId}::uuid order by "periodStart" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function setPeriodStatus(context: DatabaseContext, businessId: string, periodId: string, status: "open" | "closing" | "locked"): Promise<AccountingPeriodRow | undefined> {
  const result = await sql<AccountingPeriodRow>`
    update app.accounting_periods set "status" = ${status}, "closedAt" = case when ${status} = 'locked' then now() else "closedAt" end
    where "id" = ${periodId}::uuid and "businessId" = ${businessId}::uuid
    returning "id", "businessId", "periodStart", "periodEnd", "status", "closedAt"
  `.execute(context.transaction);
  return result.rows[0];
}

export interface PostJournalLine {
  readonly accountCode: string;
  readonly direction: "debit" | "credit";
  readonly amountMinor: string;
  readonly assetCode: string;
}

/** Calls the SECURITY DEFINER app.post_journal_entry — see migration 0042 for why this can't be a plain insert (anonymous webhook callers, the RETURNING-reselect RLS gotcha, and keeping the balance/period checks atomic with the writes). */
export async function postJournalEntry(
  context: DatabaseContext,
  businessId: string,
  userId: string | null,
  entryDate: Date,
  description: string,
  sourceType: string,
  sourceId: string,
  reversalOfId: string | null,
  lines: readonly PostJournalLine[],
): Promise<string> {
  const result = await sql<{ post_journal_entry: string }>`
    select app.post_journal_entry(
      ${businessId}::uuid, ${entryDate.toISOString().slice(0, 10)}::date, ${description}, ${sourceType}, ${sourceId},
      ${reversalOfId}::uuid, ${userId}::uuid, ${JSON.stringify(lines)}::jsonb
    )
  `.execute(context.transaction);
  return result.rows[0]!.post_journal_entry;
}

export async function listJournalEntries(context: DatabaseContext, businessId: string, limit: number): Promise<JournalEntryRow[]> {
  const result = await sql<JournalEntryRow>`
    select "id", "businessId", "entryDate", "description", "sourceType", "sourceId", "reversalOfId", "createdBy", "createdAt"
    from app.journal_entries where "businessId" = ${businessId}::uuid order by "entryDate" desc, "createdAt" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

export async function findJournalEntry(context: DatabaseContext, businessId: string, journalEntryId: string): Promise<JournalEntryRow | undefined> {
  const result = await sql<JournalEntryRow>`
    select "id", "businessId", "entryDate", "description", "sourceType", "sourceId", "reversalOfId", "createdBy", "createdAt"
    from app.journal_entries where "businessId" = ${businessId}::uuid and "id" = ${journalEntryId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listJournalLines(context: DatabaseContext, businessId: string, journalEntryId: string): Promise<JournalLineRow[]> {
  const result = await sql<JournalLineRow>`
    select line."id", line."journalEntryId", line."ledgerAccountId", account."code" as "ledgerAccountCode", account."name" as "ledgerAccountName",
      line."direction", line."amountMinor"::text as "amountMinor", line."assetCode"
    from app.journal_lines line
    join app.ledger_accounts account on account."id" = line."ledgerAccountId"
    where line."businessId" = ${businessId}::uuid and line."journalEntryId" = ${journalEntryId}::uuid
    order by line."createdAt"
  `.execute(context.transaction);
  return result.rows;
}

/** Sums every posted debit/credit per account, for the trial balance report - always as-of "now" (no historical point-in-time reconstruction), which is all a business.read caller needs today. */
export async function getTrialBalance(context: DatabaseContext, businessId: string): Promise<TrialBalanceLine[]> {
  const result = await sql<TrialBalanceLine>`
    select account."code" as "accountCode", account."name" as "accountName", account."type",
      coalesce(sum(case when line."direction" = 'debit' then line."amountMinor" else 0 end), 0)::text as "debitMinor",
      coalesce(sum(case when line."direction" = 'credit' then line."amountMinor" else 0 end), 0)::text as "creditMinor"
    from app.ledger_accounts account
    left join app.journal_lines line on line."ledgerAccountId" = account."id"
    where account."businessId" = ${businessId}::uuid
    group by account."id", account."code", account."name", account."type"
    order by account."type", account."code"
  `.execute(context.transaction);
  return result.rows;
}
