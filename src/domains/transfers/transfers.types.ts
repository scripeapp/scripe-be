/**
 * Domain and API types for the transfers domain (PROPOSED_TABLE_INVENTORY.md
 * section 9): the canonical, provider-neutral outbound money-movement engine.
 * Database row types stay separate from API types; the repository/service map
 * between them. Money crosses the API boundary as a string of minor units and
 * is a bigint inside the domain.
 */

export type BeneficiaryKind = "supplier" | "employee" | "owner" | "general";
export type BeneficiaryStatus = "active" | "archived";
export type TransferPurpose = "withdrawal" | "supplier_payment" | "payroll" | "general";
export type TransferStatus = "pending" | "awaitingApproval" | "processing" | "success" | "failed" | "rejected";
export type TransferAttemptStatus = "pending" | "processing" | "success" | "failed";

export interface TransfersOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

// --- Database row shapes (as selected) ---

export interface BeneficiaryRow {
  readonly id: string;
  readonly businessId: string;
  readonly partyId: string | null;
  readonly kind: BeneficiaryKind;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly status: BeneficiaryStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TransferRow {
  readonly id: string;
  readonly businessId: string;
  readonly beneficiaryId: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly purpose: TransferPurpose;
  readonly status: TransferStatus;
  readonly reference: string;
  readonly idempotencyKey: string | null;
  readonly journalEntryId: string | null;
  readonly approvalRequestId: string | null;
  readonly requestedBy: string | null;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface TransferAttemptRow {
  readonly id: string;
  readonly transferId: string;
  readonly businessId: string;
  readonly provider: string;
  readonly providerRecipientCode: string | null;
  readonly providerTransferCode: string | null;
  readonly providerReference: string;
  readonly status: TransferAttemptStatus;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

// --- API projections ---

export interface Beneficiary {
  readonly id: string;
  readonly partyId: string | null;
  readonly kind: BeneficiaryKind;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly status: BeneficiaryStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TransferAttempt {
  readonly id: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly providerTransferCode: string | null;
  readonly status: TransferAttemptStatus;
  readonly failureReason: string | null;
  readonly createdAt: string;
}

export interface Transfer {
  readonly id: string;
  readonly beneficiaryId: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly purpose: TransferPurpose;
  readonly status: TransferStatus;
  readonly reference: string;
  readonly journalEntryId: string | null;
  readonly approvalRequestId: string | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly TransferAttempt[];
}

// --- Service inputs ---

export interface CreateBeneficiaryInput {
  readonly kind: BeneficiaryKind;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly partyId?: string;
}

export interface RequestTransferInput {
  readonly beneficiaryId: string;
  readonly amountMinor: bigint;
  readonly purpose: TransferPurpose;
  readonly idempotencyKey: string;
  readonly reason?: string;
  /**
   * Provider-side source account the money leaves from (e.g. the business's
   * Brails/Anchor virtual account). Owned by the banking domain; supplied by
   * the caller. Omitted here means the provider uses its default source. The
   * banking merge (Path A, step 8) wires the wallet's provider account in.
   */
  readonly sourceProviderAccountId?: string;
  readonly customerEmail?: string | null;
}
