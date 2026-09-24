import { randomUUID } from "node:crypto";
import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type {
  BankAccountResolution,
  CustomerValidationResult,
  DedicatedAccountResult,
  PaymentProviderGateway,
  TransferRecipientResult,
  TransferResult,
} from "../payment-provider.js";

interface BrailsApiResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

interface BrailsVirtualAccount {
  id: string;
  customerId?: string;
  bankName?: string;
  accountName?: string;
  accountNumber?: string;
  status: "active" | "inactive" | "pending" | "needs_verification";
}

interface BrailsBeneficiaryLookup {
  accountName: string;
}

interface BrailsBeneficiary {
  id: string;
}

interface BrailsPayout {
  id: string;
  reference?: string;
  status?: string;
}

/**
 * Brails requires the sender's (the Surge business's) registered address as
 * compliance data when adding a payout beneficiary — see
 * https://docs.brails.com/docs/beneficiaries/nigeria-beneficiary. Thrown
 * when the caller didn't supply it (businesses.service exposes it once a
 * business has filled in its address via PATCH /businesses/:id).
 */
const SENDER_ADDRESS_REQUIRED = "Brails payouts require the business's registered address (city, street address, country, postcode) as sender compliance data.";

/**
 * Brails has no standalone "create customer" or "validate BVN" endpoint —
 * a single call to POST /virtual-accounts both validates identity and
 * issues the account. createCustomer/validateCustomerBvn are therefore
 * local no-ops here; the real work happens in createDedicatedAccount.
 * https://docs.brails.com/reference/virtual-accounts/create-virtual-account
 */
export class BrailsPaymentProviderGateway implements PaymentProviderGateway {
  readonly name = "brails" as const;

  private config(): { apiKey: string; baseUrl: string } {
    const environment = loadEnvironment();
    if (!environment.BRAILS_API_KEY) throw serviceUnavailableError("Brails is not configured (missing BRAILS_API_KEY).");
    return { apiKey: environment.BRAILS_API_KEY, baseUrl: environment.BRAILS_BASE_URL };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, apiVersion: "v1" | "v2" = "v1"): Promise<T> {
    const { apiKey, baseUrl } = this.config();
    const versionedBaseUrl = apiVersion === "v2" ? baseUrl.replace(/\/api\/v1$/, "/api/v2") : baseUrl;
    const response = await fetch(`${versionedBaseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json()) as BrailsApiResponse<T>;
    if (!response.ok || !payload.status) throw new Error(`Brails API error: ${payload.message ?? response.statusText}`);
    return payload.data;
  }

  createCustomer(): Promise<{ customerCode: string }> {
    return Promise.resolve({ customerCode: `pending:${randomUUID()}` });
  }

  validateCustomerBvn(): Promise<CustomerValidationResult> {
    return Promise.resolve({ status: "pending" });
  }

  async createDedicatedAccount(input: {
    customerCode: string;
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    preferredBank?: string;
    bvn?: string;
    accountType?: "INDIVIDUAL" | "CORPORATE";
    businessName?: string;
    rcNumber?: string;
    tin?: string;
  }): Promise<DedicatedAccountResult> {
    void input.customerCode;
    if (!input.bvn) throw new Error("Brails requires the customer's BVN to create a virtual account.");
    const bank = input.preferredBank === "providus" ? "providus" : "safehaven";
    const isCorporate = input.accountType === "CORPORATE" || !!input.businessName;
    const account = await this.request<BrailsVirtualAccount>("POST", "/virtual-accounts", {
      firstName: input.firstName,
      lastName: input.lastName,
      customerEmail: input.email,
      phoneNumber: input.phone,
      bank,
      type: isCorporate ? "CORPORATE" : "INDIVIDUAL",
      companyName: isCorporate ? input.businessName : undefined,
      businessName: isCorporate ? input.businessName : undefined,
      rcNumber: isCorporate ? input.rcNumber : undefined,
      tin: isCorporate ? input.tin : undefined,
      reference: `surge_${randomUUID()}`,
      bvn: input.bvn,
    });
    return toResult(account);
  }

  async requeryDedicatedAccount(input: { accountNumber: string | null; bankSlug: string | null; providerAccountId: string | null }): Promise<DedicatedAccountResult> {
    if (!input.providerAccountId) throw new Error("Cannot requery a Brails virtual account without its provider id.");
    const account = await this.request<BrailsVirtualAccount>("GET", `/virtual-accounts/${input.providerAccountId}`);
    return toResult(account);
  }

  async resolveBankAccount(accountNumber: string, bankCode: string): Promise<BankAccountResolution> {
    const result = await this.request<BrailsBeneficiaryLookup>("POST", "/beneficiaries/lookup", { country: "NG", accountNumber, bankCode }, "v2");
    return { accountName: result.accountName };
  }

  async createTransferRecipient(input: {
    name: string;
    accountNumber: string;
    bankCode: string;
    sender?: { businessName: string; addressLine1: string; city: string; country: string; postalCode: string };
  }): Promise<TransferRecipientResult> {
    if (!input.sender) throw new Error(SENDER_ADDRESS_REQUIRED);
    const environment = loadEnvironment();
    const beneficiary = await this.request<BrailsBeneficiary>(
      "POST",
      "/beneficiaries",
      {
        reference: `ben_${randomUUID()}`,
        // No webhook endpoint exists yet to receive Brails' beneficiary
        // notifications — this URL is a placeholder Brails still requires
        // as a required field, not a live handler.
        callbackUrl: `${environment.BETTER_AUTH_URL}/api/webhooks/brails`,
        country: "NG",
        currency: "NGN",
        destination: {
          type: "BANK",
          bankCode: input.bankCode,
          accountNumber: input.accountNumber,
          sender: {
            type: "BUSINESS",
            accountName: input.sender.businessName,
            city: input.sender.city,
            address: input.sender.addressLine1,
            country: input.sender.country,
            postCode: input.sender.postalCode,
          },
        },
      },
      "v2",
    );
    return { recipientCode: beneficiary.id };
  }

  async initiateTransfer(input: { amountMinor: string; recipientCode: string; reason: string; reference: string; customerEmail?: string | null }): Promise<TransferResult> {
    if (!input.customerEmail) throw new Error("Brails payouts require the business's KYC email — complete banking KYC before withdrawing.");
    const payout = await this.request<BrailsPayout>(
      "POST",
      "/wallets/payout/initialize",
      {
        amount: Number(input.amountMinor),
        sourceWalletCurrency: "NGN",
        customerEmail: input.customerEmail,
        description: input.reason,
        beneficiaryId: input.recipientCode,
      },
      "v2",
    );
    return { transferCode: payout.id, status: toTransferStatus(payout.status), reference: payout.reference ?? input.reference };
  }

  /**
   * Brails' own docs call POST /wallets/payout/finalize "part of the legacy
   * payout flow" and recommend Quote + Initiate Payout for new
   * integrations — but it's still the only documented way to re-check a
   * payout's status after initiation, so it's used here as that, not as an
   * OTP-style confirmation step (Brails has none).
   */
  async finalizeTransfer(input: { transferCode: string }): Promise<TransferResult> {
    const payout = await this.request<BrailsPayout>("POST", "/wallets/payout/finalize", { transactionId: input.transferCode }, "v2");
    return { transferCode: payout.id, status: toTransferStatus(payout.status), reference: payout.reference ?? "" };
  }
}

function toTransferStatus(status: string | undefined): TransferResult["status"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("success") || normalized.includes("complete")) return "success";
  if (normalized.includes("fail") || normalized.includes("decline") || normalized.includes("reject")) return "failed";
  return "processing";
}

function toResult(account: BrailsVirtualAccount): DedicatedAccountResult {
  return {
    providerAccountId: account.id,
    accountNumber: account.accountNumber ?? null,
    accountName: account.accountName ?? null,
    bankName: account.bankName ?? null,
    bankSlug: account.bankName ?? null,
    assignmentReference: null,
    status: account.status === "active" ? "active" : account.status === "inactive" ? "failed" : "pending",
  };
}
