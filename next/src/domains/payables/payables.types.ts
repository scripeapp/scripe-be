/**
 * API and domain types for the bill, bill line, and bill payment allocation domain
 * belong here. Database row types remain generated and separate.
 */
export interface PayablesOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface BillLineInput { readonly description: string; readonly quantity: number; readonly unitAmountMinor: number; readonly taxMinor?: number; readonly lineTotalMinor: number; readonly accountCategory: string; readonly purchaseOrderId?: string | null; readonly purchaseOrderLineId?: string | null; readonly goodsReceiptId?: string | null; }
export interface CreateBillInput { readonly supplierAccountId?: string | null; readonly billNumber: string; readonly billType?: "supplier" | "utility" | "tax" | "rent" | "other"; readonly assetCode?: string; readonly issuedAt?: string | null; readonly dueAt?: string | null; readonly subtotalMinor: number; readonly taxMinor?: number; readonly totalMinor: number; readonly notes?: string; readonly lines: readonly BillLineInput[]; }
export interface AllocatePaymentInput { readonly paymentReference: string; readonly amountMinor: number; readonly assetCode: string; readonly paidAt?: string; }
