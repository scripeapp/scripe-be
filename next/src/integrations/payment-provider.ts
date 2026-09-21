import { loadEnvironment } from "../shared/environment.js";
import { serviceUnavailableError } from "../shared/errors.js";
import { AnchorPaymentProviderGateway } from "./providers/anchor-payment-provider.js";
import { BrailsPaymentProviderGateway } from "./providers/brails-payment-provider.js";

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
  /** Explicit rather than inferred from accountNumber presence — some providers (e.g. Anchor) provision asynchronously and "no accountNumber yet" means still pending, not failed. */
  readonly status: "pending" | "active" | "failed";
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
 * provider. `paymentProvider` selects an implementation based on
 * BANKING_PROVIDER ("brails" | "anchor"), falling back to
 * UnconfiguredPaymentProviderGateway (SERVICE_UNAVAILABLE, never a faked
 * success) when unset or misconfigured. Brails and Anchor currently
 * implement virtual-account issuance only (resolveBankAccount and the
 * transfer methods are out of scope for this pass — see each provider file);
 * a Paystack/Flutterwave implementation for the payments domain's checkout
 * gateway is a separate, later piece of work, unrelated to this interface.
 */
export interface PaymentProviderGateway {
  readonly name: "brails" | "anchor" | "unconfigured";
  resolveBankAccount(accountNumber: string, bankCode: string): Promise<BankAccountResolution>;
  createCustomer(input: { email: string; firstName: string; lastName: string; phone: string }): Promise<{ customerCode: string }>;
  validateCustomerBvn(input: {
    customerCode: string;
    firstName: string;
    lastName: string;
    bvn: string;
    bankCode: string;
    accountNumber: string;
    /** Required by some providers' identity verification (e.g. Anchor); unused by others. */
    dateOfBirth?: string;
    gender?: "male" | "female" | "other";
  }): Promise<CustomerValidationResult>;
  createDedicatedAccount(input: {
    customerCode: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    preferredBank?: string;
    /** Required by providers that validate identity as part of account creation itself (e.g. Brails); already-validated for others (e.g. Paystack, via a prior validateCustomerBvn call). */
    bvn?: string;
  }): Promise<DedicatedAccountResult>;
  /** providerAccountId is the account's id at the provider (e.g. Brails' UUID, Anchor's account id) — some providers requery by id rather than by account number/bank slug, and an account still provisioning asynchronously may not have an accountNumber yet. */
  requeryDedicatedAccount(input: { accountNumber: string | null; bankSlug: string | null; providerAccountId: string | null }): Promise<DedicatedAccountResult>;
  createTransferRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
    /** Sender compliance details required by some providers when adding a payout beneficiary (e.g. Brails); ignored by others. */
    sender?: { businessName: string; addressLine1: string; city: string; country: string; postalCode: string };
  }): Promise<TransferRecipientResult>;
  /**
   * sourceAccountId is the provider's own account id to debit (e.g. Anchor's
   * DepositAccount id) — required by providers whose transfers move money
   * out of a specific customer account rather than a platform-wide balance
   * (e.g. Paystack's "source: balance"). customerEmail is required by
   * providers whose payout call is tied to a customer record by email
   * (e.g. Brails) rather than an account/recipient id alone.
   */
  initiateTransfer(input: {
    amountMinor: string;
    recipientCode: string;
    reference: string;
    reason: string;
    sourceAccountId?: string | null;
    customerEmail?: string | null;
  }): Promise<TransferResult>;
  /** A no-op/status-check for providers whose transfers complete on initiation (e.g. Anchor, Brails) — no OTP step exists there, unlike Paystack. */
  finalizeTransfer(input: { transferCode: string; otp: string }): Promise<TransferResult>;
}

class UnconfiguredPaymentProviderGateway implements PaymentProviderGateway {
  readonly name = "unconfigured" as const;

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

/**
 * Lazily resolved (like objectStorage in r2.ts) so a missing/misconfigured
 * BANKING_PROVIDER fails individual calls with SERVICE_UNAVAILABLE rather
 * than crashing the whole app at import time.
 */
class SelectedPaymentProviderGateway implements PaymentProviderGateway {
  private resolved: PaymentProviderGateway | undefined;

  private resolve(): PaymentProviderGateway {
    if (this.resolved) return this.resolved;
    const provider = loadEnvironment().BANKING_PROVIDER;
    this.resolved = provider === "brails" ? new BrailsPaymentProviderGateway() : provider === "anchor" ? new AnchorPaymentProviderGateway() : new UnconfiguredPaymentProviderGateway();
    return this.resolved;
  }

  get name(): PaymentProviderGateway["name"] {
    return this.resolve().name;
  }

  resolveBankAccount(...args: Parameters<PaymentProviderGateway["resolveBankAccount"]>): ReturnType<PaymentProviderGateway["resolveBankAccount"]> {
    return this.resolve().resolveBankAccount(...args);
  }

  createCustomer(...args: Parameters<PaymentProviderGateway["createCustomer"]>): ReturnType<PaymentProviderGateway["createCustomer"]> {
    return this.resolve().createCustomer(...args);
  }

  validateCustomerBvn(...args: Parameters<PaymentProviderGateway["validateCustomerBvn"]>): ReturnType<PaymentProviderGateway["validateCustomerBvn"]> {
    return this.resolve().validateCustomerBvn(...args);
  }

  createDedicatedAccount(...args: Parameters<PaymentProviderGateway["createDedicatedAccount"]>): ReturnType<PaymentProviderGateway["createDedicatedAccount"]> {
    return this.resolve().createDedicatedAccount(...args);
  }

  requeryDedicatedAccount(...args: Parameters<PaymentProviderGateway["requeryDedicatedAccount"]>): ReturnType<PaymentProviderGateway["requeryDedicatedAccount"]> {
    return this.resolve().requeryDedicatedAccount(...args);
  }

  createTransferRecipient(...args: Parameters<PaymentProviderGateway["createTransferRecipient"]>): ReturnType<PaymentProviderGateway["createTransferRecipient"]> {
    return this.resolve().createTransferRecipient(...args);
  }

  initiateTransfer(...args: Parameters<PaymentProviderGateway["initiateTransfer"]>): ReturnType<PaymentProviderGateway["initiateTransfer"]> {
    return this.resolve().initiateTransfer(...args);
  }

  finalizeTransfer(...args: Parameters<PaymentProviderGateway["finalizeTransfer"]>): ReturnType<PaymentProviderGateway["finalizeTransfer"]> {
    return this.resolve().finalizeTransfer(...args);
  }
}

export const paymentProvider: PaymentProviderGateway = new SelectedPaymentProviderGateway();
