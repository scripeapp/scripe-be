import { serviceUnavailableError } from "../shared/errors.js";

export interface BankAccountResolution {
  readonly accountName: string;
}

export interface CustomerValidationResult {
  readonly status: "verified" | "pending";
}

export interface DedicatedAccountResult {
  readonly providerAccountId: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly bankName: string | null;
  readonly bankSlug: string | null;
  readonly assignmentReference: string | null;
}

export interface TransferRecipientResult {
  readonly recipientCode: string;
}

export interface TransferResult {
  readonly transferCode: string;
  readonly status: "pending" | "processing" | "success" | "failed";
  readonly reference: string;
}

/**
 * Real money movement — bank-account resolution, BVN/KYC validation,
 * dedicated virtual accounts, and transfers — all go through a payments
 * provider (Paystack in legacy). Per product decision, this pass builds the
 * banking domain's schema and orchestration only; no provider is wired in
 * yet, so every call here throws SERVICE_UNAVAILABLE rather than pretending
 * money moved. A real implementation can replace UnconfiguredPaymentProviderGateway
 * without touching banking.service.ts.
 */
export interface PaymentProviderGateway {
  resolveBankAccount(accountNumber: string, bankCode: string): Promise<BankAccountResolution>;
  createCustomer(input: { email: string; firstName: string; lastName: string; phone: string }): Promise<{ customerCode: string }>;
  validateCustomerBvn(input: {
    customerCode: string;
    firstName: string;
    lastName: string;
    bvn: string;
    bankCode: string;
    accountNumber: string;
  }): Promise<CustomerValidationResult>;
  createDedicatedAccount(input: {
    customerCode: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    preferredBank?: string;
  }): Promise<DedicatedAccountResult>;
  requeryDedicatedAccount(input: { accountNumber: string; bankSlug: string }): Promise<DedicatedAccountResult>;
  createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<TransferRecipientResult>;
  initiateTransfer(input: { amountMinor: string; recipientCode: string; reference: string; reason: string }): Promise<TransferResult>;
  finalizeTransfer(input: { transferCode: string; otp: string }): Promise<TransferResult>;
}

class UnconfiguredPaymentProviderGateway implements PaymentProviderGateway {
  private unavailable(): never {
    throw serviceUnavailableError("Banking provider is not configured yet.");
  }

  resolveBankAccount(): Promise<BankAccountResolution> {
    this.unavailable();
  }

  createCustomer(): Promise<{ customerCode: string }> {
    this.unavailable();
  }

  validateCustomerBvn(): Promise<CustomerValidationResult> {
    this.unavailable();
  }

  createDedicatedAccount(): Promise<DedicatedAccountResult> {
    this.unavailable();
  }

  requeryDedicatedAccount(): Promise<DedicatedAccountResult> {
    this.unavailable();
  }

  createTransferRecipient(): Promise<TransferRecipientResult> {
    this.unavailable();
  }

  initiateTransfer(): Promise<TransferResult> {
    this.unavailable();
  }

  finalizeTransfer(): Promise<TransferResult> {
    this.unavailable();
  }
}

export const paymentProvider: PaymentProviderGateway = new UnconfiguredPaymentProviderGateway();
