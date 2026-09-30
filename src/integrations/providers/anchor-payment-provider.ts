import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError, validationError, type AppError } from "../../shared/errors.js";
import type {
  BankAccountResolution,
  BusinessCustomerInput,
  BusinessDocument,
  BusinessDocumentSubmissionResult,
  BusinessPersonInput,
  KybAddress,
  KybIdType,
  KybRegistrationType,
  RequiredBusinessDocument,
  CustomerValidationResult,
  DedicatedAccountResult,
  PaymentProviderGateway,
  TransferRecipientResult,
  TransferResult,
} from "../payment-provider.js";

interface AnchorIncludedItem {
  id: string;
  type: string;
  attributes: {
    accountNumber?: string;
    accountName?: string;
    bank?: { id?: string; name?: string; nipCode?: string };
    status?: string;
    isDefault?: boolean;
    permanent?: boolean;
    currency?: string;
    [key: string]: unknown;
  };
}

interface AnchorJsonApiDocument<TAttributes> {
  data: {
    id: string;
    type: string;
    attributes: TAttributes;
  };
  included?: AnchorIncludedItem[];
}

interface AnchorJsonApiList<TAttributes> {
  data: { id: string; type: string; attributes: TAttributes }[];
}

interface AnchorDocumentAttributes {
  documentType?: string;
  type?: string;
  description?: string;
  /** FILE or TEXT. */
  format?: string;
  submitted?: boolean;
  verified?: boolean;
}

interface AnchorBusinessCustomerAttributes {
  officers?: { officerId?: string }[];
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

  private async request<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: Record<string, unknown>): Promise<AnchorJsonApiDocument<T>> {
    const { apiKey, baseUrl } = this.config();
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { "x-anchor-key": apiKey, accept: "application/json", "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw await anchorError(method, path, response);
    const text = await response.text();
    return (text ? JSON.parse(text) : { data: {} }) as AnchorJsonApiDocument<T>;
  }

  private async requestList<T>(method: "GET", path: string): Promise<AnchorJsonApiList<T>> {
    const { apiKey, baseUrl } = this.config();
    const response = await fetch(`${baseUrl}${path}`, { method, headers: { "x-anchor-key": apiKey, accept: "application/json" } });
    if (!response.ok) throw await anchorError(method, path, response);
    const body = (await response.json()) as { data?: AnchorJsonApiList<T>["data"] };
    return { data: Array.isArray(body.data) ? body.data : [] };
  }

  private async requestMultipart(path: string, form: FormData): Promise<void> {
    const { apiKey, baseUrl } = this.config();
    // No content-type header: fetch sets the multipart boundary itself.
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: { "x-anchor-key": apiKey, accept: "application/json" }, body: form });
    if (!response.ok) throw await anchorError("POST", path, response);
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
            // entities we onboard it is the primary director's BVN.
            businessBvn: primaryPerson(input).bvn,
            registrationType: ANCHOR_REGISTRATION_TYPE[input.registrationType],
            industry: toAnchorIndustry(input.industry),
            country: input.address.country,
            dateOfRegistration: input.dateOfRegistration,
            description: input.description ?? undefined,
            website: input.website ?? undefined,
          },
          contact: {
            email: { general: input.email },
            phoneNumber: toLocalPhone(input.phone),
            address: { main: toAnchorAddress(input.address), registered: toAnchorAddress(input.registeredAddress) },
          },
          officers: input.people.flatMap(toAnchorOfficers),
        },
      },
    });
    return { customerCode: document.data.id };
  }

  /**
   * https://docs.getanchor.co/docs/manage-business-customers — the business
   * details and addresses are patched in place; officers are replaced by
   * adding the current ones before removing the old (a customer can't be
   * left with none).
   */
  async updateBusinessCustomer(customerCode: string, input: BusinessCustomerInput): Promise<void> {
    await this.request("PATCH", `/businesses/${customerCode}`, {
      data: {
        type: "BusinessCustomerV2",
        attributes: {
          businessName: input.businessName,
          registrationType: ANCHOR_REGISTRATION_TYPE[input.registrationType],
          dateOfRegistration: input.dateOfRegistration,
          address: { main: toAnchorAddress(input.address), registered: toAnchorAddress(input.registeredAddress) },
        },
      },
    });
    const existing = await this.request<AnchorBusinessCustomerAttributes>("GET", `/customers/${customerCode}`);
    const staleOfficerIds = (existing.data.attributes.officers ?? []).map((officer) => officer.officerId).filter((id): id is string => !!id);
    for (const officer of input.people.flatMap(toAnchorOfficers)) {
      await this.request("POST", `/businesses/${customerCode}/officers`, { data: { type: "BusinessOfficer", attributes: officer } });
    }
    for (const officerId of staleOfficerIds) {
      await this.request("DELETE", `/businesses/${customerCode}/officers/${officerId}`);
    }
  }

  /** https://docs.getanchor.co/docs/business-customer-creation#required-business-documents — depends on registration type and date. */
  async requiredBusinessDocuments(input: { registrationType: KybRegistrationType; dateOfRegistration: string }): Promise<RequiredBusinessDocument[]> {
    const query = new URLSearchParams({ registrationType: ANCHOR_REGISTRATION_TYPE[input.registrationType], registrationDate: input.dateOfRegistration });
    const list = await this.requestList<AnchorDocumentAttributes>("GET", `/documents?${query.toString()}`);
    return list.data.map((document) => {
      const type = document.attributes.type ?? document.attributes.documentType ?? "";
      return { type, description: document.attributes.description ?? type, input: ANCHOR_TEXT_DOCUMENTS.has(type) ? "text" : "file" };
    });
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
      const document = input.documents.find((candidate) => candidate.documentType === documentType);
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
    let result = toResult(document.data.id, document.data.attributes, document.included);
    if (result.status === "active" && !result.accountNumber) {
      result = await this.fetchActiveAccountNumber(document.data.id, result);
    }
    return result;
  }

  async requeryDedicatedAccount(input: { providerAccountId: string | null }): Promise<DedicatedAccountResult> {
    if (!input.providerAccountId) throw new Error("Cannot requery an Anchor deposit account without its provider id.");
    const document = await this.request<AnchorAccountAttributes>("GET", `/accounts/${input.providerAccountId}?include=AccountNumber`);
    let result = toResult(document.data.id, document.data.attributes, document.included);
    if (result.status === "active" && !result.accountNumber) {
      result = await this.fetchActiveAccountNumber(input.providerAccountId, result);
    }
    return result;
  }

  private async fetchActiveAccountNumber(accountId: string, current: DedicatedAccountResult): Promise<DedicatedAccountResult> {
    try {
      const accountDoc = await this.request<AnchorAccountAttributes>("GET", `/accounts/${accountId}?include=AccountNumber`);
      const fromDoc = toResult(accountDoc.data.id, accountDoc.data.attributes, accountDoc.included);
      if (fromDoc.accountNumber) return fromDoc;

      const numbersList = await this.requestList<{
        accountNumber?: string;
        accountName?: string;
        bank?: { id?: string; name?: string; nipCode?: string };
        status?: string;
      }>("GET", `/account-numbers?AccountId=${accountId}`);
      const activeNumber =
        numbersList.data.find((entry) => entry.attributes.accountNumber && (!entry.attributes.status || entry.attributes.status === "ACTIVE")) ??
        numbersList.data[0];
      if (activeNumber?.attributes.accountNumber && !activeNumber.attributes.accountNumber.includes("*")) {
        return {
          ...current,
          accountNumber: activeNumber.attributes.accountNumber,
          accountName: activeNumber.attributes.accountName ?? current.accountName,
          bankName: activeNumber.attributes.bank?.name ?? current.bankName,
          bankSlug: activeNumber.attributes.bank?.nipCode ?? current.bankSlug,
        };
      }
    } catch (error) {
      console.warn(`Anchor account number resolution for ${accountId} deferred:`, error);
    }
    return current;
  }

  private normalizeBankCode(bankCode: string): string {
    const CBN_TO_NIP: Record<string, string> = {
      "044": "000014", // Access Bank
      "023": "000009", // Citibank Nigeria
      "050": "000010", // Ecobank Nigeria
      "070": "000007", // Fidelity Bank
      "011": "000016", // First Bank of Nigeria
      "214": "000003", // First City Monument Bank
      "058": "000013", // Guaranty Trust Bank
      "030": "000020", // Heritage Bank
      "082": "000002", // Keystone Bank
      "50211": "090267", // Kuda Bank
      "50515": "090405", // Moniepoint MFB
      "999992": "100004", // OPay
      "999991": "100033", // PalmPay
      "076": "000008", // Polaris Bank
      "101": "000023", // Providus Bank
      "221": "000012", // Stanbic IBTC Bank
      "068": "000021", // Standard Chartered Bank
      "232": "000001", // Sterling Bank
      "100": "000022", // Suntrust Bank
      "032": "000018", // Union Bank of Nigeria
      "033": "000004", // United Bank for Africa
      "215": "000011", // Unity Bank
      "035": "000017", // Wema Bank
      "057": "000015", // Zenith Bank
    };
    return CBN_TO_NIP[bankCode] ?? bankCode;
  }

  async resolveBankAccount(accountNumber: string, bankCode: string): Promise<BankAccountResolution> {
    const resolvedBankCode = this.normalizeBankCode(bankCode);
    const document = await this.request<AnchorVerifyAccountAttributes>("GET", `/payments/verify-account/${resolvedBankCode}/${accountNumber}`);
    if (!document.data.attributes.accountName) throw new Error("Anchor could not resolve this account.");
    return { accountName: document.data.attributes.accountName };
  }

  async createTransferRecipient(input: { name: string; accountNumber: string; bankCode: string }): Promise<TransferRecipientResult> {
    const resolvedBankCode = this.normalizeBankCode(input.bankCode);
    const document = await this.request<AnchorCounterPartyAttributes>("POST", "/counterparties", {
      data: {
        type: "CounterParty",
        attributes: { bankCode: resolvedBankCode, accountName: input.name, accountNumber: input.accountNumber, verifyName: true },
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

/**
 * Turns an Anchor error response into something a merchant can act on.
 * A 400 about what they entered (an invalid BVN, a bad date) shows Anchor's
 * own message; anything that is our side's problem — credentials, our
 * organisation's fee balance, Anchor being down — reads as temporarily
 * unavailable, with the detail logged for us.
 */
async function anchorError(method: string, path: string, response: Response): Promise<AppError> {
  const text = await response.text();
  let detail = text;
  try {
    const parsed = JSON.parse(text) as { errors?: { detail?: string; title?: string }[] };
    detail = parsed.errors?.map((error) => error.detail ?? error.title).filter(Boolean).join("; ") || text;
  } catch {
    // not JSON; keep the raw text
  }
  console.warn(`Anchor API error (${response.status}) on ${method} ${path}: ${detail}`);
  const ours = response.status === 401 || response.status === 403 || response.status >= 500 || /insufficient balance/i.test(detail);
  if (ours || (response.status !== 400 && response.status !== 422)) return serviceUnavailableError("Banking is temporarily unavailable. Please try again shortly.");
  return validationError(`Our banking partner couldn't accept this: ${detail}`, { provider: "anchor" });
}

function toTransferStatus(status: AnchorTransferAttributes["status"]): TransferResult["status"] {
  if (status === "COMPLETED" || (status as string) === "SUCCESSFUL") return "success";
  if (status === "FAILED" || status === "REVERSED") return "failed";
  return "processing";
}

function primaryPerson(input: BusinessCustomerInput): BusinessPersonInput {
  const person = input.people.find((candidate) => candidate.isPrimary);
  if (!person) throw new Error("A business customer needs a primary signatory");
  return person;
}

/** Anchor's document types whose value is text (sent as textData), not a file. */
const ANCHOR_TEXT_DOCUMENTS = new Set(["RC_NUMBER", "BN_NUMBER", "CAC_IT_NUMBER", "TIN"]);

const ANCHOR_ID_TYPE: Record<KybIdType, string> = {
  nin: "NIN_SLIP",
  passport: "PASSPORT",
  drivers_license: "DRIVERS_LICENSE",
  voters_card: "VOTERS_CARD",
};

/**
 * Anchor gives each officer one role, so someone who is both a director and
 * a shareholder is sent as two officers (confirmed against the sandbox: it
 * accepts the pair and treats the OWNER entry as satisfying the ownership
 * requirement).
 */
function toAnchorOfficers(person: BusinessPersonInput) {
  const base = {
    fullName: { firstName: person.firstName, lastName: person.lastName, middleName: person.middleName ?? undefined },
    nationality: person.nationality,
    address: toAnchorAddress(person.address),
    dateOfBirth: person.dateOfBirth,
    email: person.email,
    phoneNumber: toLocalPhone(person.phone),
    bvn: person.bvn,
    title: person.title,
    identificationType: ANCHOR_ID_TYPE[person.idType],
    idDocumentNumber: person.idNumber,
  };
  const officers = [];
  if (person.role === "director" || person.role === "director_owner") officers.push({ ...base, role: "DIRECTOR", percentageOwned: 0 });
  if (person.role === "owner" || person.role === "director_owner") officers.push({ ...base, role: "OWNER", percentageOwned: person.ownershipPercent });
  return officers;
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


/**
 * Anchor's industry is a fixed list (the "Industry" tab under Registration
 * Types and Industry in https://docs.getanchor.co/docs/business-customer-creation).
 * Our KYB form offers broader categories, mapped here; an Anchor value is
 * passed through as-is.
 */
const ANCHOR_INDUSTRY: Record<string, string> = {
  "Pharmacy & Healthcare": "Health_Pharmacies",
  "Retail & Supermarket": "Retail",
  "Food & Beverage / Restaurant": "Hospitality_Restaurants",
  "Fashion & Apparel": "Commerce_PhysicalGoods",
  "Electronics & Gadgets": "Commerce_PhysicalGoods",
  "Beauty & Personal Care": "Commerce_PhysicalServices",
  "Automotive & Transportation": "Commerce_Automobiles",
  "Information Technology": "Commerce_DigitalServices",
  "Consulting & Professional Services": "Commerce_ProfessionalServices",
  "Education & Training": "Education_VocationalTraining",
  "Real Estate & Construction": "Commerce_RealEstate",
  "Agriculture & Farming": "Agriculture_AgriculturalServices",
  Other: "OtherProfessionalServices",
};

function toAnchorIndustry(category: string): string {
  return ANCHOR_INDUSTRY[category.trim()] ?? category.trim();
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

function toResult(id: string, attributes: AnchorAccountAttributes, included?: AnchorIncludedItem[]): DedicatedAccountResult {
  const accountNumItem = included?.find((item) => item.type === "AccountNumber" && item.attributes?.accountNumber);

  let accountNumber = attributes.virtualNuban?.accountNumber ?? accountNumItem?.attributes?.accountNumber ?? attributes.accountNumber ?? null;
  if (accountNumber && accountNumber.includes("*")) {
    accountNumber = accountNumItem?.attributes?.accountNumber ?? null;
  }

  const bankName = attributes.virtualNuban?.bankName ?? accountNumItem?.attributes?.bank?.name ?? attributes.bank?.name ?? null;
  const bankSlug = accountNumItem?.attributes?.bank?.nipCode ?? attributes.bank?.nipCode ?? null;
  const accountName = accountNumItem?.attributes?.accountName ?? attributes.accountName ?? null;

  const status: DedicatedAccountResult["status"] =
    attributes.status === "ACTIVE" ? "active" : attributes.status === "CLOSED" || attributes.status === "REJECTED" ? "failed" : "pending";

  return {
    providerAccountId: id,
    accountNumber,
    accountName,
    bankName,
    bankSlug,
    assignmentReference: null,
    status,
  };
}
