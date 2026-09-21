/**
 * API and domain types for the asset, ledger account, journal, period, rate, and
 * financial reporting domain belong here. Database row types remain generated and
 * separate.
 */

export interface AccountingOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export type LedgerAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

/** Symbolic codes for the standard chart every business is seeded with - used both by seedDefaultChartOfAccounts and by every domain that posts journal entries, so callers never spell out the raw string more than once. */
export const LEDGER_ACCOUNT_CODES = {
  CASH: "cash",
  BANK: "bank",
  GATEWAY_CLEARING: "gateway_clearing",
  INVENTORY: "inventory",
  ACCOUNTS_PAYABLE: "accounts_payable",
  REFUNDS_PAYABLE: "refunds_payable",
  TAX_PAYABLE: "tax_payable",
  REVENUE: "revenue",
  SALES_RETURNS: "sales_returns",
  COGS: "cogs",
  WASTE_EXPENSE: "waste_expense",
  GENERAL_EXPENSE: "general_expense",
  RENT_EXPENSE: "rent_expense",
  UTILITIES_EXPENSE: "utilities_expense",
  TAX_EXPENSE: "tax_expense",
  FEES_EXPENSE: "fees_expense",
  PAYROLL_EXPENSE: "payroll_expense",
} as const;

export type LedgerAccountCode = (typeof LEDGER_ACCOUNT_CODES)[keyof typeof LEDGER_ACCOUNT_CODES];

export interface LedgerAccountRow {
  readonly id: string;
  readonly businessId: string;
  readonly code: string;
  readonly name: string;
  readonly type: LedgerAccountType;
  readonly isSystem: boolean;
  readonly status: "active" | "archived";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface LedgerAccount {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly type: LedgerAccountType;
  readonly status: "active" | "archived";
}

export type JournalDirection = "debit" | "credit";

export interface JournalLineInput {
  readonly accountCode: string;
  readonly direction: JournalDirection;
  readonly amountMinor: bigint;
  readonly assetCode: string;
}

export interface PostJournalEntryInput {
  readonly entryDate?: Date;
  readonly description: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversalOfId?: string | null;
  readonly lines: readonly JournalLineInput[];
}

export interface JournalEntryRow {
  readonly id: string;
  readonly businessId: string;
  readonly entryDate: Date;
  readonly description: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversalOfId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export interface JournalLineRow {
  readonly id: string;
  readonly journalEntryId: string;
  readonly ledgerAccountId: string;
  readonly ledgerAccountCode: string;
  readonly ledgerAccountName: string;
  readonly direction: JournalDirection;
  readonly amountMinor: string;
  readonly assetCode: string;
}

export interface JournalEntry {
  readonly id: string;
  readonly entryDate: string;
  readonly description: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly reversalOfId: string | null;
  readonly createdAt: string;
  readonly lines: readonly {
    readonly accountCode: string;
    readonly accountName: string;
    readonly direction: JournalDirection;
    readonly amountMinor: string;
    readonly assetCode: string;
  }[];
}

export type AccountingPeriodStatus = "open" | "closing" | "locked";

export interface AccountingPeriodRow {
  readonly id: string;
  readonly businessId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly status: AccountingPeriodStatus;
  readonly closedAt: Date | null;
}

export interface AccountingPeriod {
  readonly id: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: AccountingPeriodStatus;
}

export interface TrialBalanceLine {
  readonly accountCode: string;
  readonly accountName: string;
  readonly type: LedgerAccountType;
  readonly debitMinor: string;
  readonly creditMinor: string;
}
