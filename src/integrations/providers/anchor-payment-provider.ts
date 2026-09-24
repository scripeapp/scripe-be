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

interface AnchorJsonApiDocument<TAttributes> {
  data: {
    id: string;
    type: string;
    attributes: TAttributes;
  };
}

interface AnchorCustomerAttributes {
  fullName?: { firstName?: string; lastName?: string };
  email?: string;
  phoneNumber?: string;
  verification?: { status?: string };
  status?: string;
}

interface AnchorAccountAttributes {
  accountNumber?: string;
  accountName?: string;
  bank?: { name?: string; nipCode?: string };
  status?: string;
  virtualNuban?: { accountNumber?: string; bankName?: string };
}

interface AnchorVerifyAccountAttributes {
  accountName?: string;
}

interface AnchorCounterPartyAttributes {
  accountName?: string;
}

interface AnchorTransferAttributes {
  reference?: string;
  status?: "PENDING" | "COMPLETED" | "FAILED" | "REVERSED";
}

/**
 * Anchor provisions both identity verification and deposit accounts
 * asynchronously (a 202-accepted create-account call, real status only
 * confirmed via webhook) — https://docs.getanchor.co/docs/business-customer-kyb,
 * https://docs.getanchor.co/docs/manage-deposit-account. Without a
 * provider-events/webhook domain built yet, createDedicatedAccount here
 * returns whatever the create call gives synchronously (usually nothing
 * more than a pending id) and requeryDedicatedAccount is how the caller
 * resolves that in-flight state later.
 */
export class AnchorPaymentProviderGateway implements PaymentProviderGateway {
  readonly name = "anchor" as const;

  private config(): { apiKey: string; baseUrl: string } {
    const environment = loadEnvironment();
    if (!environment.ANCHOR_API_KEY) throw serviceUnavailableError("Anchor is not configured (missing ANCHOR_API_KEY).");
    return { apiKey: environment.ANCHOR_API_KEY, baseUrl: environment.ANCHOR_BASE_URL };
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<AnchorJsonApiDocument<T>> {
    const { apiKey, baseUrl } = this.config();
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "x-anchor-key": apiKey, accept: "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anchor API error (${response.status}): ${errorBody}`);
    }
    return (await response.json()) as AnchorJsonApiDocument<T>;
  }

  async createCustomer(input: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    businessName?: string;
    rcNumber?: string;
    businessType?: string;
  }): Promise<{ customerCode: string }> {
    if (input.businessName) {
      const document = await this.request<AnchorCustomerAttributes>("POST", "/customers", {
        data: {
          type: "BusinessCustomer",
          attributes: {
            organizationName: input.businessName,
            registrationNumber: input.rcNumber,
            registrationType: input.businessType === "sole_proprietorship" ? "BN" : "RC",
            email: input.email,
            phoneNumber: input.phone,
            address: { country: "NG" },
          },
        },
      });
      return { customerCode: document.data.id };
    }
    const document = await this.request<AnchorCustomerAttributes>("POST", "/customers", {
      data: {
        type: "IndividualCustomer",
        attributes: {
          fullName: { firstName: input.firstName, lastName: input.lastName },
          address: { country: "NG" },
          email: input.email,
          phoneNumber: input.phone,
        },
      },
    });
    return { customerCode: document.data.id };
  }

  async validateCustomerBvn(input: { customerCode: string; bvn: string; dateOfBirth?: string; gender?: "male" | "female" | "other" }): Promise<CustomerValidationResult> {
    await this.request("POST", `/customers/${input.customerCode}/verification/individual`, {
      data: {
        type: "Verification",
        attributes: {
          level: "TIER_2",
          level2: {
            bvn: input.bvn,
            dateOfBirth: input.dateOfBirth,
            gender: input.gender ? capitalize(input.gender) : undefined,
          },
        },
      },
    });
    // Anchor confirms Tier 2 identity verification asynchronously via
    // webhook (customer.identification.approved/rejected) — not implemented
    // in this pass, so this can never synchronously report "verified".
    return { status: "pending" };
  }

  async createDedicatedAccount(input: {
    customerCode: string;
    accountType?: "INDIVIDUAL" | "CORPORATE";
    businessName?: string;
  }): Promise<DedicatedAccountResult> {
    const isCorporate = input.accountType === "CORPORATE" || !!input.businessName;
    const document = await this.request<AnchorAccountAttributes>("POST", "/accounts", {
      data: {
        type: "DepositAccount",
        attributes: { productType: isCorporate ? "CURRENT" : "SAVINGS" },
        relationships: { customer: { data: { id: input.customerCode, type: isCorporate ? "BusinessCustomer" : "IndividualCustomer" } } },
      },
    });
    return toResult(document.data.id, document.data.attributes);
  }

  async requeryDedicatedAccount(input: { providerAccountId: string | null }): Promise<DedicatedAccountResult> {
    if (!input.providerAccountId) throw new Error("Cannot requery an Anchor deposit account without its provider id.");
    const document = await this.request<AnchorAccountAttributes>("GET", `/accounts/${input.providerAccountId}`);
    return toResult(document.data.id, document.data.attributes);
  }

  async resolveBankAccount(accountNumber: string, bankCode: string): Promise<BankAccountResolution> {
    const document = await this.request<AnchorVerifyAccountAttributes>("GET", `/payments/verify-account/${bankCode}/${accountNumber}`);
    if (!document.data.attributes.accountName) throw new Error("Anchor could not resolve this account.");
    return { accountName: document.data.attributes.accountName };
  }

  async createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<TransferRecipientResult> {
    const document = await this.request<AnchorCounterPartyAttributes>("POST", "/counterparties", {
      data: {
        type: "CounterParty",
        attributes: { bankCode: input.bankCode, accountName: input.name, accountNumber: input.accountNumber, verifyName: true },
      },
    });
    return { recipientCode: document.data.id };
  }

  async initiateTransfer(input: { amountMinor: string; recipientCode: string; reference: string; reason: string; sourceAccountId?: string | null }): Promise<TransferResult> {
    if (!input.sourceAccountId) throw new Error("Anchor transfers require the source deposit account's provider id.");
    const document = await this.request<AnchorTransferAttributes>("POST", "/transfers", {
      data: {
        type: "NIPTransfer",
        attributes: { amount: Number(input.amountMinor), currency: "NGN", reason: input.reason, reference: input.reference },
        relationships: {
          account: { data: { id: input.sourceAccountId, type: "DepositAccount" } },
          counterParty: { data: { id: input.recipientCode, type: "CounterParty" } },
        },
      },
    });
    return { transferCode: document.data.id, status: toTransferStatus(document.data.attributes.status), reference: document.data.attributes.reference ?? input.reference };
  }

  /** Anchor transfers complete on initiation — no OTP step exists, unlike Paystack. This just re-checks the transfer's current status. */
  async finalizeTransfer(input: { transferCode: string }): Promise<TransferResult> {
    const document = await this.request<AnchorTransferAttributes>("GET", `/transfers/verify/${input.transferCode}`);
    return { transferCode: input.transferCode, status: toTransferStatus(document.data.attributes.status), reference: document.data.attributes.reference ?? "" };
  }
}

function toTransferStatus(status: AnchorTransferAttributes["status"]): TransferResult["status"] {
  if (status === "COMPLETED") return "success";
  if (status === "FAILED" || status === "REVERSED") return "failed";
  return "processing";
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toResult(id: string, attributes: AnchorAccountAttributes): DedicatedAccountResult {
  const accountNumber = attributes.virtualNuban?.accountNumber ?? attributes.accountNumber ?? null;
  const status: DedicatedAccountResult["status"] = attributes.status === "ACTIVE" ? "active" : attributes.status === "CLOSED" || attributes.status === "REJECTED" ? "failed" : "pending";
  return {
    providerAccountId: id,
    accountNumber,
    accountName: attributes.accountName ?? null,
    bankName: attributes.virtualNuban?.bankName ?? attributes.bank?.name ?? null,
    bankSlug: attributes.bank?.nipCode ?? null,
    assignmentReference: null,
    status,
  };
}
