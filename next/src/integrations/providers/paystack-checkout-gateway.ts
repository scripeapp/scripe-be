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
    const data = await this.request<PaystackInitializeData>("POST", "/transaction/initialize", {
      amount: Number(input.amountMinor),
      email: input.email,
      reference: input.reference,
      currency: input.assetCode,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
    });
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  async verifyCheckout(reference: string): Promise<CheckoutVerification> {
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
