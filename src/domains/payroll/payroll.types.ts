/**
 * Domain and API types for the payroll domain (PROPOSED_TABLE_INVENTORY.md
 * section 11). A run owns immutable computed totals; each item's net pay is
 * executed as an app.transfers row. Money is a bigint inside the domain and a
 * string of minor units across the API boundary.
 */

export type PayrollRunStatus = "draft" | "approved" | "processing" | "paid" | "partially_paid" | "cancelled";
export type PayrollItemStatus = "pending" | "paid" | "failed";

export interface PayrollOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

// --- Row shapes ---

export interface PayrollRunRow {
  readonly id: string;
  readonly businessId: string;
  readonly reference: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: PayrollRunStatus;
  readonly assetCode: string;
  readonly grossMinor: string;
  readonly deductionsMinor: string;
  readonly netMinor: string;
  readonly journalEntryId: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PayrollItemRow {
  readonly id: string;
  readonly payrollRunId: string;
  readonly businessId: string;
  readonly beneficiaryId: string;
  readonly partyId: string | null;
  readonly grossMinor: string;
  readonly deductionsMinor: string;
  readonly netMinor: string;
  readonly transferId: string | null;
  readonly status: PayrollItemStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- API projections ---

export interface PayrollItem {
  readonly id: string;
  readonly beneficiaryId: string;
  readonly partyId: string | null;
  readonly grossMinor: string;
  readonly deductionsMinor: string;
  readonly netMinor: string;
  readonly transferId: string | null;
  readonly status: PayrollItemStatus;
}

export interface PayrollRun {
  readonly id: string;
  readonly reference: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly status: PayrollRunStatus;
  readonly assetCode: string;
  readonly grossMinor: string;
  readonly deductionsMinor: string;
  readonly netMinor: string;
  readonly journalEntryId: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly items: readonly PayrollItem[];
}

// --- Service inputs ---

export interface PayrollItemInput {
  readonly beneficiaryId: string;
  readonly partyId?: string;
  readonly grossMinor: bigint;
  readonly deductionsMinor: bigint;
}

export interface CreatePayrollRunInput {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly items: readonly PayrollItemInput[];
}
