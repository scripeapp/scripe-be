import { FlutterwaveCheckoutGateway } from "./providers/flutterwave-checkout-gateway.js";
import { PaystackCheckoutGateway } from "./providers/paystack-checkout-gateway.js";

export interface InitializeCheckoutInput {
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly email: string;
  readonly reference: string;
  readonly callbackUrl?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface InitializedCheckout {
  readonly authorizationUrl: string;
  readonly reference: string;
}

export interface CheckoutVerification {
  readonly status: "success" | "failed" | "pending";
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly paidAt: string | null;
  readonly failureReason: string | null;
}

/**
 * A customer-facing checkout: initialize sends the customer to the
 * provider's hosted payment page, verify confirms whether they actually
 * paid. Distinct from PaymentProviderGateway (banking's KYC/virtual-account/
 * transfer concern) — this is purely order-payment collection, matching
 * legacy's IPaymentProvider (Paystack/Flutterwave) split from BankingService.
 */
export interface CheckoutGateway {
  readonly name: "paystack" | "flutterwave";
  initializeCheckout(input: InitializeCheckoutInput): Promise<InitializedCheckout>;
  verifyCheckout(reference: string): Promise<CheckoutVerification>;
}

const gateways: Record<"paystack" | "flutterwave", CheckoutGateway> = {
  paystack: new PaystackCheckoutGateway(),
  flutterwave: new FlutterwaveCheckoutGateway(),
};

/** Both gateways construct cheaply (no client/SDK setup until a call actually needs credentials) — the caller picks which one per checkout. */
export function getCheckoutGateway(name: "paystack" | "flutterwave"): CheckoutGateway {
  return gateways[name];
}
