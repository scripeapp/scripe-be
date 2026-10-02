import { FlutterwaveCheckoutGateway } from "./providers/flutterwave-checkout-gateway.js";
import { PaystackCheckoutGateway } from "./providers/paystack-checkout-gateway.js";

export interface InitializeCheckoutInput {
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly email: string;
  readonly reference: string;
  readonly callbackUrl?: string;
  readonly metadata?: Record<string, unknown>;
  /**
   * Paystack subaccount the business's sale settles to (see
   * domains/banking/checkout-subaccounts.ts). Omitted for Scripe's own
   * revenue (subscriptions, message credits). Flutterwave ignores it.
   */
  readonly subaccountCode?: string;
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

const paystackGateway = new PaystackCheckoutGateway();

const gateways: Record<"paystack" | "flutterwave", CheckoutGateway> = {
  paystack: paystackGateway,
  flutterwave: new FlutterwaveCheckoutGateway(),
};

/** The Paystack gateway itself, for its subaccount calls (settlement setup), which are not part of the CheckoutGateway contract. */
export function getPaystackGateway(): PaystackCheckoutGateway {
  return paystackGateway;
}

/** Both gateways construct cheaply (no client/SDK setup until a call actually needs credentials) — the caller picks which one per checkout. */
export function getCheckoutGateway(name: "paystack" | "flutterwave"): CheckoutGateway {
  return gateways[name];
}
