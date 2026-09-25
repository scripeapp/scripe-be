import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type {
  BankAccountResolution,
  BusinessCustomerInput,
  BusinessDocument,
  BusinessDocumentKind,
  BusinessDocumentSubmissionResult,
  KybAddress,
  KybRegistrationType,
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

interface AnchorJsonApiList<TAttributes> {
  data: { id: string; type: string; attributes: TAttributes }[];
}

interface AnchorDocumentAttributes {
  documentType?: string;
  type?: string;
  description?: string;
  submitted?: boolean;
  verified?: boolean;
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
  readonly verifiesBusinesses = true;

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

  private async requestList<T>(method: "GET", path: string): Promise<AnchorJsonApiList<T>> {
    const { apiKey, baseUrl } = this.config();
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { "x-anchor-key": apiKey, accept: "application/json" } });
    if (!response.ok) throw new Error(`Anchor API error (${response.status}): ${await response.text()}`);
    const body = (await response.json()) as { data?: AnchorJsonApiList<T>["data"] };
    return { data: Array.isArray(body.data) ? body.data : [] };
  }

  private async requestMultipart(path: string, form: FormData): Promise<void> {
    const { apiKey, baseUrl } = this.config();
    // No content-type header: fetch sets the multipart boundary itself.
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "x-anchor-key": apiKey, accept: "application/json" }, body: form });
    if (!response.ok) throw new Error(`Anchor API error (${response.status}): ${await response.text()}`);
  }

  async createCustomer(input: { email: string; firstName: string; lastName: string; phone: string }): Promise<{ customerCode: string }> {
    const document = await this.request<AnchorCustomerAttributes>("POST", "/customers", {
      data: {
        type: "IndividualCustomer",
        attributes: {
          fullName: { firstName: input.firstName, lastName: input.lastName },
          address: { country: "NG" },
          email: input.email,
          phoneNumber: toLocalPhone(input.phone),
        },
      },
    });
    return { customerCode: document.data.id };
  }

  /** https://docs.getanchor.co/docs/business-customer-creation — basicDetail, contact and at least one officer are required. */
  async createBusinessCustomer(input: BusinessCustomerInput): Promise<{ customerCode: string }> {
    const document = await this.request<AnchorCustomerAttributes>("POST", "/customers", {
      data: {
        type: "BusinessCustomer",
        attributes: {
          address: { country: input.address.country, state: toAnchorState(input.address.state) },
          basicDetail: {
            businessName: input.businessName,
            // Anchor's example sends a BVN here without defining it; for the
            // entities we onboard it is the principal director's BVN.
            businessBvn: input.director.bvn,
            registrationType: ANCHOR_REGISTRATION_TYPE[input.registrationType],
            industry: input.industry,
            country: input.address.country,
            dateOfRegistration: input.dateOfRegistration,
            description: input.description ?? undefined,
            website: input.website ?? undefined,
          },
          contact: {
            email: { general: input.email },
            phoneNumber: toLocalPhone(input.phone),
            address: { main: toAnchorAddress(input.address), registered: toAnchorAddress(input.address) },
          },
          officers: [
            {
              role: "DIRECTOR",
              fullName: { firstName: input.director.firstName, lastName: input.director.lastName, middleName: input.director.middleName ?? undefined },
              nationality: input.director.nationality,
              address: toAnchorAddress(input.director.address),
              dateOfBirth: input.director.dateOfBirth,
              email: input.director.email,
              phoneNumber: toLocalPhone(input.director.phone),
              bvn: input.director.bvn,
              title: "Director",
            },
          ],
        },
      },
    });
    return { customerCode: document.data.id };
  }

  /** https://docs.getanchor.co/docs/business-customer-kyb — the decision arrives as customer.identification.* webhooks. */
  async submitBusinessVerification(input: { customerCode: string }): Promise<CustomerValidationResult> {
    await this.request("POST", `/customers/${input.customerCode}/verification/business`);
    return { status: "pending" };
  }

  /**
   * Uploads the documents Anchor has requested (GET /documents/:customerId)
   * via POST /documents/upload-document/:customerId/:documentId, multipart
   * with `fileData` and/or `textData` (RC/TIN values go in textData).
   */
  async submitBusinessDocuments(input: { customerCode: string; documents: readonly BusinessDocument[] }): Promise<BusinessDocumentSubmissionResult> {
    const requested = await this.requestList<AnchorDocumentAttributes>("GET", `/documents/${input.customerCode}`);
    const submitted: string[] = [];
    const missing: string[] = [];
    for (const request of requested.data) {
      const documentType = request.attributes.documentType ?? request.attributes.type ?? "";
      if (request.attributes.submitted || request.attributes.verified) continue;
      const kind = anchorDocumentKind(documentType);
      const document = kind ? input.documents.find((candidate) => candidate.kind === kind) : undefined;
      if (!document || (!document.file && !document.text)) {
        missing.push(documentType);
        continue;
      }
      const form = new FormData();
      if (document.file) {
        const bytes = await document.file.load();
        form.append("fileData", new Blob([bytes], { type: document.file.mimeType }), document.file.fileName);
      }
      if (document.text) form.append("textData", document.text);
      await this.requestMultipart(`/documents/upload-document/${input.customerCode}/${request.id}`, form);
      submitted.push(documentType);
    }
    return { submitted, missing };
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

  /** https://docs.getanchor.co/docs/creating-deposit-account-resource — BusinessCustomer takes CURRENT only, IndividualCustomer SAVINGS only, and both must have passed KYC/KYB first. */
  async createDedicatedAccount(input: { customerCode: string; accountType?: "INDIVIDUAL" | "CORPORATE" }): Promise<DedicatedAccountResult> {
    const isCorporate = input.accountType === "CORPORATE";
    const document = await this.request<AnchorAccountAttributes>("POST", "/accounts", {
      data: {
        type: "DepositAccount",
        attributes: { productName: isCorporate ? "CURRENT" : "SAVINGS" },
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

/**
 * Only Private_Incorporated appears in Anchor's public docs; the other two
 * follow CAC's registration categories (business name / incorporated
 * trustees) and must be confirmed against the Anchor sandbox.
 */
const ANCHOR_REGISTRATION_TYPE: Record<KybRegistrationType, string> = {
  limited_liability: "Private_Incorporated",
  sole_proprietorship: "Business_Name",
  ngo_cooperative: "Incorporated_Trustees",
};

/** Anchor document types from its KYB guide (FORM_CAC_3, RC_NUMBER, CERTIFICATE_OF_INCORPORATION, PROOF_OF_ADDRESS) plus close variants. */
function anchorDocumentKind(documentType: string): BusinessDocumentKind | null {
  const type = documentType.toUpperCase();
  if (type.includes("CERTIFICATE_OF_INCORPORATION") || type.includes("CERTIFICATE_OF_REGISTRATION")) return "certificate_of_incorporation";
  if (type.includes("PROOF_OF_ADDRESS") || type.includes("UTILITY")) return "proof_of_address";
  if (type === "RC_NUMBER" || type === "BN_NUMBER" || type.includes("REGISTRATION_NUMBER")) return "registration_number";
  if (type === "TIN" || type.includes("TAX_IDENTIFICATION")) return "tax_identification_number";
  if (type.includes("STATUS_REPORT") || type.startsWith("FORM_CAC") || type.includes("MEMART")) return "status_report";
  if (type.includes("DIRECTOR") || type.includes("IDENTITY") || type.includes("ID_CARD") || type.includes("PASSPORT")) return "director_id";
  return null;
}

function toAnchorState(state: string): string {
  return state.trim().toUpperCase();
}

function toAnchorAddress(address: KybAddress) {
  return {
    country: address.country,
    state: toAnchorState(address.state),
    addressLine_1: address.addressLine1,
    addressLine_2: address.addressLine2 ?? address.addressLine1,
    city: address.city,
    postalCode: address.postalCode,
  };
}

/** Anchor's examples use the local 11-digit form (07012345678). */
function toLocalPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.startsWith("234") && digits.length === 13) return `0${digits.slice(3)}`;
  return digits;
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
