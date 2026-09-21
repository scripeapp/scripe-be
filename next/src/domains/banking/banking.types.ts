export type KycStatus = "not_started" | "pending" | "verified" | "failed";
export type VirtualAccountStatus = "pending" | "active" | "failed";
export type WalletTransactionType = "deposit" | "withdrawal" | "reversal" | "adjustment" | "bill_payment";
export type WalletTransactionDirection = "credit" | "debit";
export type WalletTransactionStatus = "pending" | "posted";
export type WithdrawalStatus = "pending" | "processing" | "success" | "failed";

export interface BankingProfileRow {
  readonly businessId: string;
  readonly kycStatus: KycStatus;
  readonly kycFailureReason: string | null;
  readonly kycSubmittedAt: Date | null;
  readonly kycVerifiedAt: Date | null;
  readonly providerCustomerCode: string | null;
  readonly email: string | null;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface VirtualAccountRow {
  readonly id: string;
  readonly businessId: string;
  readonly provider: string;
  readonly providerCustomerCode: string | null;
  readonly providerAccountId: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly bankName: string | null;
  readonly bankSlug: string | null;
  readonly assetCode: string;
  readonly status: VirtualAccountStatus;
  readonly assignmentReference: string | null;
  readonly failureReason: string | null;
  readonly metadata: Record<string, unknown>;
  readonly lastRequeryAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WalletTransactionRow {
  readonly id: string;
  readonly businessId: string;
  readonly type: WalletTransactionType;
  readonly direction: WalletTransactionDirection;
  readonly status: WalletTransactionStatus;
  readonly assetCode: string;
  readonly amountMinor: string;
  readonly grossAmountMinor: string | null;
  readonly feeAmountMinor: string;
  readonly feeBreakdown: Record<string, unknown>;
  readonly provider: string;
  readonly providerReference: string;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly postedAt: Date | null;
  readonly createdAt: Date;
}

export interface WithdrawalRow {
  readonly id: string;
  readonly businessId: string;
  readonly requestedBy: string | null;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly transferRecipientCode: string | null;
  readonly providerReference: string;
  readonly providerTransferCode: string | null;
  readonly idempotencyKey: string | null;
  readonly status: WithdrawalStatus;
  readonly failureReason: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BankingOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface BankingStatus {
  readonly kycStatus: KycStatus;
  readonly kycFailureReason: string | null;
  readonly virtualAccount: VirtualAccountRow | null;
  readonly availableBalanceMinor: string;
  readonly assetCode: string;
}

export interface SubmitKycInput {
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly phone: string;
  readonly bvn: string;
  readonly bankCode: string;
  readonly accountNumber: string;
}

export interface RequestVirtualAccountInput {
  readonly preferredBank?: string;
}

export interface RequestWithdrawalInput {
  readonly amountMinor: number;
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly idempotencyKey: string;
}

export interface FinalizeWithdrawalInput {
  readonly transferCode: string;
  readonly otp: string;
}

export interface ResolveBankAccountInput {
  readonly accountNumber: string;
  readonly bankCode: string;
}

export interface ListWalletTransactionsFilter {
  readonly limit?: number;
  readonly offset?: number;
}
