import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { DisableSubscriptionInput, InitializeSubscriptionInput, InitializedSubscriptionCheckout, SubscriptionBillingGateway } from "../subscription-billing.js";

interface PaystackApiResponse<T> {
  status: boolean;
  message: string;
  data: T;
}

interface PaystackInitializeData {
  authorization_url: string;
  reference: string;
}

/** Ported from legacy business-subscription.service.ts's direct fetch() calls to /transaction/initialize (with a plan code) and /subscription/disable. */
export class PaystackSubscriptionBilling implements SubscriptionBillingGateway {
  readonly name = "paystack" as const;

  private secretKey(): string {
    const key = loadEnvironment().PAYSTACK_SECRET_KEY;
    if (!key) throw serviceUnavailableError("Paystack is not configured (missing PAYSTACK_SECRET_KEY).");
    return key;
  }

  private async request<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`https://api.paystack.co${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secretKey()}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as PaystackApiResponse<T>;
    if (!response.ok || !payload.status) throw new Error(`Paystack API error: ${payload.message ?? response.statusText}`);
    return payload.data;
  }

  async initializeSubscription(input: InitializeSubscriptionInput): Promise<InitializedSubscriptionCheckout> {
    const data = await this.request<PaystackInitializeData>("/transaction/initialize", {
      email: input.email,
      plan: input.planCode,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
    });
    return { authorizationUrl: data.authorization_url, reference: data.reference };
  }

  async disableSubscription(input: DisableSubscriptionInput): Promise<void> {
    await this.request("/subscription/disable", { code: input.subscriptionCode, token: input.emailToken });
  }
}
