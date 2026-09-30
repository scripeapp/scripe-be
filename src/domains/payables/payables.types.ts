/**
 * API and domain types for the bill, bill line, and bill payment allocation domain
 * belong here. Database row types remain generated and separate.
 */
export interface PayablesOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface BillLineInput { readonly description: string; readonly quantity: number; readonly unitAmountMinor: number; readonly taxMinor?: number; readonly lineTotalMinor: number; readonly accountCategory: string; readonly purchaseOrderId?: string | null; readonly purchaseOrderLineId?: string | null; readonly goodsReceiptId?: string | null; }
export interface CreateBillInput { readonly supplierAccountId?: string | null; readonly billNumber: string; readonly billType?: "supplier" | "utility" | "tax" | "rent" | "other"; readonly assetCode?: string; readonly issuedAt?: string | null; readonly dueAt?: string | null; readonly subtotalMinor: number; readonly taxMinor?: number; readonly totalMinor: number; readonly notes?: string; readonly lines: readonly BillLineInput[]; }
export interface AllocatePaymentInput { readonly paymentReference: string; readonly amountMinor: number; readonly assetCode: string; readonly paidAt?: string; }
export type AllocatePaymentResult = { readonly gated: false; readonly id: string } | { readonly gated: true; readonly approvalRequestId: string };
export interface ListBillsFilter {
  readonly status?: string;
  readonly supplierAccountId?: string;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface BillRow {
  readonly id: string;
  readonly businessId: string;
  readonly supplierAccountId: string | null;
  readonly billNumber: string;
  readonly billType: string;
  readonly status: string;
  readonly assetCode: string;
  readonly issuedAt: string | null;
  readonly dueAt: string | null;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly amountPaidMinor: string;
  readonly notes: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supplierName?: string | null;
  /** Detail view only: where a wallet payment for this bill goes. */
  readonly supplierBankName?: string | null;
  readonly supplierAccountNumber?: string | null;
  readonly supplierAccountName?: string | null;
  readonly itemsCount?: number;
}

export interface BillLineRow {
  readonly id: string;
  readonly businessId: string;
  readonly billId: string;
  readonly description: string;
  readonly quantity: string;
  readonly unitAmountMinor: string;
  readonly taxMinor: string;
  readonly lineTotalMinor: string;
  readonly accountCategory: string;
  readonly purchaseOrderId: string | null;
  readonly purchaseOrderLineId: string | null;
  readonly goodsReceiptId: string | null;
  readonly createdAt: string;
}

export interface BillPaymentAllocationRow {
  readonly id: string;
  readonly businessId: string;
  readonly billId: string;
  readonly paymentReference: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly paidAt: string;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface BillMetricsResult {
  readonly outstandingMinor: string;
  readonly outstandingCount: number;
  readonly dueThisWeekMinor: string;
  readonly dueThisWeekCount: number;
  readonly overdueMinor: string;
  readonly overdueCount: number;
  readonly paidThisMonthMinor: string;
  readonly paidThisMonthCount: number;
}

export interface UpdateBillInput {
  readonly status?: "draft" | "approved" | "voided";
  readonly dueAt?: string | null;
  readonly notes?: string;
}

export interface BillTransferTarget {
  readonly id: string;
  readonly billNumber: string;
  readonly status: string;
  readonly assetCode: string;
  readonly totalMinor: string;
  readonly amountPaidMinor: string;
  readonly inFlightMinor: string;
  readonly supplierName: string | null;
  readonly bankCode: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
}

export interface BillTransferRow {
  readonly id: string;
  readonly amountMinor: string;
  readonly status: "pending" | "awaitingApproval" | "processing" | "success" | "failed" | "rejected";
  readonly providerReference: string;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly approvalRequestId: string | null;
  /** The approval's steps snapshot (who approves, who has decided). */
  readonly approvalSteps: unknown[] | null;
  readonly pendingApproverIds: string[];
}

export interface PayBillInput {
  /** Defaults to everything still owed that isn't already on its way. */
  readonly amountMinor?: number;
  readonly idempotencyKey: string;
}
