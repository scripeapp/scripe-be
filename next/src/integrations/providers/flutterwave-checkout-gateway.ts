import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { CheckoutGateway, CheckoutVerification, InitializeCheckoutInput, InitializedCheckout } from "../checkout-gateway.js";

const FLW_API_URL = "https://api.flutterwave.com/v3";

interface FlutterwaveInitializeResponse {
  status: string;
  message: string;
  data: { link: string };
}

interface FlutterwaveTransaction {
  tx_ref: string;
  amount: number;
  currency: string;
  status: string;
  created_at: string;
  processor_response?: string;
}

interface FlutterwaveVerifyResponse {
  status: string;
  data: FlutterwaveTransaction[] | FlutterwaveTransaction;
}

/**
 * https://developer.flutterwave.com/docs/collecting-payments/standard —
 * Flutterwave's `amount` is major units (naira), unlike this system's
 * amountMinor (kobo), so every amount is converted at the boundary.
 */
export class FlutterwaveCheckoutGateway implements CheckoutGateway {
  readonly name = "flutterwave" as const;

  private secretKey(): string {
    const key = loadEnvironment().FLW_SECRET_KEY;
    if (!key) throw serviceUnavailableError("Flutterwave checkout is not configured (missing FLW_SECRET_KEY).");
    return key;
  }

  async initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout> {
    const response = await fetch(`${FLW_API_URL}/payments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.secretKey()}`, "content-type": "application/json" },
      body: JSON.stringify({
        tx_ref: input.reference,
        amount: minorToMajor(input.amountMinor),
        currency: input.assetCode,
        redirect_url: input.callbackUrl ?? "",
        customer: { email: input.email },
        meta: flattenMeta(input.metadata),
      }),
    });
    const payload = (await response.json()) as FlutterwaveInitializeResponse;
    if (!response.ok || payload.status !== "success" || !payload.data?.link) throw new Error(`Flutterwave API error: ${payload.message ?? response.statusText}`);
    return { authorizationUrl: payload.data.link, reference: input.reference };
  }

  async verifyCheckout(reference: string): Promise<CheckoutVerification> {
    const response = await fetch(`${FLW_API_URL}/transactions?tx_ref=${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${this.secretKey()}` },
    });
    const payload = (await response.json()) as FlutterwaveVerifyResponse;
    if (!response.ok || payload.status !== "success") throw new Error(`Flutterwave API error: ${response.statusText}`);

    const transaction = Array.isArray(payload.data) ? payload.data[0] : payload.data;
    if (!transaction) return { status: "pending", amountMinor: "0", assetCode: "", paidAt: null, failureReason: null };

    return {
      status: transaction.status === "successful" ? "success" : transaction.status === "failed" ? "failed" : "pending",
      amountMinor: String(majorToMinor(transaction.amount)),
      assetCode: transaction.currency,
      paidAt: transaction.status === "successful" ? transaction.created_at : null,
      failureReason: transaction.status === "failed" ? (transaction.processor_response ?? "Payment failed") : null,
    };
  }
}

function minorToMajor(amountMinor: string): number {
  return Number(amountMinor) / 100;
}

function majorToMinor(amountMajor: number): number {
  return Math.round(amountMajor * 100);
}

function flattenMeta(metadata?: Record<string, unknown>): Record<string, string | number | boolean> {
  const flat: Record<string, string | number | boolean> = { provider: "flutterwave" };
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (value === null || value === undefined) continue;
    flat[key] = typeof value === "object" ? JSON.stringify(value) : (value as string | number | boolean);
  }
  return flat;
}
