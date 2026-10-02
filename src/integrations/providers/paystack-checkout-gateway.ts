import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { CheckoutGateway, CheckoutVerification, InitializeCheckoutInput, InitializedCheckout } from "../checkout-gateway.js";

interface PaystackApiResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackInitializeData {
  authorization_url: string;
  access_code: string;
  reference: string;
}

interface PaystackBank {
  name: string;
  slug: string;
  code: string;
  active: boolean;
}

interface PaystackSubaccountData {
  subaccount_code: string;
}

export interface CreateSubaccountInput {
  readonly businessName: string;
  readonly bankName: string | null;
  readonly bankSlug: string | null;
  readonly accountNumber: string;
}

export interface CreatedSubaccount {
  readonly subaccountCode: string;
  readonly bankCode: string;
}

interface PaystackVerifyData {
  status: "success" | "failed" | "abandoned";
  amount: number;
  currency: string;
  paid_at: string | null;
  gateway_response: string;
}

/** https://paystack.com/docs/payments/accept-payments — amountMinor is passed straight through as Paystack's `amount`, since Paystack's own minor unit (kobo for NGN) already matches this system's. */
export class PaystackCheckoutGateway implements CheckoutGateway {
  readonly name = "paystack" as const;

  /** Only with PAYSTACK_MOCK_CHECKOUT=true and no secret key (never in production): what each mock checkout was initialized for, so mock verification reports the real amount instead of a blanket success. */
  private readonly mockCheckouts = new Map<string, { amountMinor: string; assetCode: string; subaccountCode?: string }>();

  private secretKey(): string {
    const key = loadEnvironment().PAYSTACK_SECRET_KEY;
    if (!key) throw serviceUnavailableError("Paystack checkout is not configured (missing PAYSTACK_SECRET_KEY).");
    return key;
  }

  private async request<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.paystack.co${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey()}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = (await response.json()) as PaystackApiResponse<T>;
    if (!response.ok || !payload.status) throw new Error(`Paystack API error: ${payload.message ?? response.statusText}`);
    return payload.data;
  }

  async initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout> {
    const env = loadEnvironment();
    if (!env.PAYSTACK_SECRET_KEY && env.PAYSTACK_MOCK_CHECKOUT) {
      console.log(`[paystack:dev] Initialized mock checkout ref=${input.reference} amount=${input.amountMinor}`);
      this.mockCheckouts.set(input.reference, { amountMinor: input.amountMinor, assetCode: input.assetCode, subaccountCode: input.subaccountCode });
      const callback = input.callbackUrl || `${env.FRONTEND_URL}/payment-processing`;
      const sep = callback.includes("?") ? "&" : "?";
      return {
        authorizationUrl: `${callback}${sep}reference=${encodeURIComponent(input.reference)}&status=success&mock=true`,
        reference: input.reference,
      };
    }

    const data = await this.request<PaystackInitializeData>("POST", "/transaction/initialize", {
      amount: Number(input.amountMinor),
      email: input.email,
      reference: input.reference,
      currency: input.assetCode,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
      // Settles the sale to the business; the business (subaccount) bears Paystack's fee.
      ...(input.subaccountCode ? { subaccount: input.subaccountCode, bearer: "subaccount" } : {}),
    });
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  /**
   * https://paystack.com/docs/payments/multi-split-payments — creates the
   * business's subaccount, settling to `accountNumber`. The bank is matched
   * against Paystack's own bank list by slug, then by name, because the
   * banking provider names banks its own way. No platform charge in v1.
   */
  async createSubaccount(input: CreateSubaccountInput): Promise<CreatedSubaccount> {
    const env = loadEnvironment();
    if (!env.PAYSTACK_SECRET_KEY && env.PAYSTACK_MOCK_CHECKOUT) {
      console.log(`[paystack:dev] Created mock subaccount for account=${input.accountNumber}`);
      return { subaccountCode: `ACCT_mock_${input.accountNumber}`, bankCode: "000" };
    }

    const banks = await this.request<PaystackBank[]>("GET", "/bank?country=nigeria&perPage=500");
    const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wantedSlug = input.bankSlug ? normalize(input.bankSlug) : null;
    const wantedName = input.bankName ? normalize(input.bankName) : null;
    const bank =
      banks.find((candidate) => candidate.active && wantedSlug !== null && normalize(candidate.slug) === wantedSlug) ??
      banks.find((candidate) => candidate.active && wantedName !== null && normalize(candidate.name) === wantedName);
    if (!bank) throw new Error(`Paystack does not list the settlement bank "${input.bankName ?? input.bankSlug ?? "unknown"}"`);

    const data = await this.request<PaystackSubaccountData>("POST", "/subaccount", {
      business_name: input.businessName,
      settlement_bank: bank.code,
      account_number: input.accountNumber,
      percentage_charge: 0,
    });
    return { subaccountCode: data.subaccount_code, bankCode: bank.code };
  }

  /** Test seam: the subaccount a mock checkout was initialized with. */
  mockSubaccountFor(reference: string): string | undefined {
    return this.mockCheckouts.get(reference)?.subaccountCode;
  }

  async verifyCheckout(reference: string): Promise<CheckoutVerification> {
    const env = loadEnvironment();
    if (!env.PAYSTACK_SECRET_KEY && env.PAYSTACK_MOCK_CHECKOUT) {
      const mock = this.mockCheckouts.get(reference);
      if (!mock) return { status: "pending", amountMinor: "0", assetCode: "", paidAt: null, failureReason: null };
      return {
        status: "success",
        amountMinor: mock.amountMinor,
        assetCode: mock.assetCode,
        paidAt: new Date().toISOString(),
        failureReason: null,
      };
    }

    const data = await this.request<PaystackVerifyData>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
    return {
      status: data.status === "success" ? "success" : data.status === "abandoned" ? "pending" : "failed",
      amountMinor: String(data.amount),
      assetCode: data.currency,
      paidAt: data.paid_at,
      failureReason: data.status === "failed" ? data.gateway_response : null,
    };
  }
}
