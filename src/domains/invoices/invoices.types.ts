export type InvoiceDocumentStatus = "draft" | "open" | "void";

export type InvoiceStatus = "draft" | "pending" | "partially_paid" | "paid" | "overdue" | "void";

export interface InvoiceRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly channelId: string;
  readonly customerPartyId: string | null;
  readonly orderId: string | null;
  readonly fiscalDocumentId: string | null;
  readonly status: InvoiceDocumentStatus;
  readonly invoiceNumber: string | null;
  readonly issueDate: Date | string;
  readonly dueDate: Date | string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly discountMinor: string;
  readonly totalMinor: string;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly publicToken: string;
  readonly payToVirtualAccountId: string | null;
  readonly payToBankName: string | null;
  readonly payToAccountNumber: string | null;
  readonly payToAccountName: string | null;
  readonly sentAt: Date | null;
  readonly voidedAt: Date | null;
  readonly lastReminderAt: Date | null;
  readonly transferReportedAt: Date | null;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InvoiceLineRow {
  readonly id: string;
  readonly businessId: string;
  readonly invoiceId: string;
  readonly productVariantId: string | null;
  readonly description: string;
  readonly quantity: string | number;
  readonly unitPriceMinor: string;
  readonly taxRateBps: number;
  readonly discountMinor: string;
  readonly lineTotalMinor: string;
  readonly sortOrder: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface InvoiceCustomerInfo {
  readonly id?: string | null;
  readonly name: string;
  readonly email: string;
  readonly phone?: string | null;
}

export interface InvoiceBankDetails {
  readonly bankName: string;
  readonly accountNumber: string;
  readonly accountName: string;
}

export interface InvoiceLine {
  readonly id: string;
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: string;
  readonly taxRateBps: number;
  readonly discountMinor: string;
  readonly lineTotalMinor: string;
  readonly productVariantId: string | null;
  readonly sortOrder: number;
}

export interface Invoice {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly channelId: string;
  readonly invoiceNumber: string | null;
  readonly status: InvoiceStatus;
  readonly documentStatus: InvoiceDocumentStatus;
  readonly issueDate: string;
  readonly dueDate: string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly discountMinor: string;
  readonly totalMinor: string;
  readonly amountPaidMinor: string;
  readonly balanceDueMinor: string;
  readonly notes: string | null;
  readonly terms: string | null;
  readonly publicToken: string;
  readonly publicUrl?: string;
  readonly bankDetails: InvoiceBankDetails | null;
  readonly customer: InvoiceCustomerInfo | null;
  readonly orderId: string | null;
  readonly fiscalDocumentId: string | null;
  readonly sentAt: string | null;
  readonly voidedAt: string | null;
  readonly lastReminderAt: string | null;
  /** The customer said on the public page that they paid by bank transfer; the merchant still has to record it. */
  readonly transferReportedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: InvoiceLine[];
}

export interface InvoiceMetrics {
  readonly totalInvoicedMinor: string;
  readonly paidAmountMinor: string;
  readonly pendingAmountMinor: string;
  readonly overdueAmountMinor: string;
  readonly totalCount: number;
  readonly paidCount: number;
  readonly pendingCount: number;
  readonly overdueCount: number;
}

export interface CreateInvoiceLineInput {
  readonly description: string;
  readonly quantity: number;
  readonly unitPriceMinor: string | number | bigint;
  readonly taxRateBps?: number;
  readonly discountMinor?: string | number | bigint;
  readonly productVariantId?: string;
  readonly sortOrder?: number;
}

export interface CreateInvoiceInput {
  readonly storeId?: string;
  readonly customerPartyId?: string;
  readonly customer?: {
    readonly name: string;
    readonly email: string;
    readonly phone?: string;
    readonly address?: string;
    readonly city?: string;
    readonly state?: string;
  };
  readonly issueDate?: string;
  readonly dueDate: string;
  readonly currency?: string;
  readonly discountMinor?: string | number | bigint;
  readonly notes?: string;
  readonly terms?: string;
  readonly lines: CreateInvoiceLineInput[];
}

export interface UpdateInvoiceInput {
  readonly storeId?: string;
  readonly customerPartyId?: string;
  readonly customer?: {
    readonly name: string;
    readonly email: string;
    readonly phone?: string;
    readonly address?: string;
    readonly city?: string;
    readonly state?: string;
  };
  readonly issueDate?: string;
  readonly dueDate?: string;
  readonly currency?: string;
  readonly discountMinor?: string | number | bigint;
  readonly notes?: string;
  readonly terms?: string;
  readonly lines?: CreateInvoiceLineInput[];
}

export interface ListInvoicesFilter {
  readonly status?: InvoiceStatus;
  readonly customerId?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface RecordInvoicePaymentInput {
  readonly amountMinor: string | number | bigint;
  readonly method: "cash" | "bank_transfer" | "card" | "online";
  readonly externalReference?: string;
  readonly notes?: string;
  readonly idempotencyKey?: string;
}

export interface InvoiceOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}
