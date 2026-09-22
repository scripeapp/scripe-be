export type FiscalDocumentKind = "receipt" | "invoice" | "credit_note";

export interface FiscalDocumentRow {
  readonly id: string;
  readonly businessId: string;
  readonly orderId: string;
  readonly kind: FiscalDocumentKind;
  readonly sequence: string;
  readonly number: string;
  readonly currency: string;
  readonly subtotalMinor: string;
  readonly taxMinor: string;
  readonly totalMinor: string;
  readonly issuedAt: Date;
  readonly createdBy: string;
}

export interface FiscalDocument extends Omit<FiscalDocumentRow, "issuedAt"> {
  readonly issuedAt: string;
}

export interface ReceiptsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}
