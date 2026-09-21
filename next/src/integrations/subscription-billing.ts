import { PaystackSubscriptionBilling } from "./providers/paystack-subscription-billing.js";

export interface InitializeSubscriptionInput {
  readonly email: string;
  readonly planCode: string;
  readonly reference: string;
  readonly callbackUrl?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface InitializedSubscriptionCheckout {
  readonly authorizationUrl: string;
  readonly reference: string;
}

export interface DisableSubscriptionInput {
  readonly subscriptionCode: string;
  readonly emailToken: string;
}

/**
 * Recurring-billing plan checkout, distinct from CheckoutGateway (which is
 * a one-off customer order payment and is also multi-provider). Legacy's
 * business-subscription flow was Paystack-only (Flutterwave has no
 * equivalent plan-code recurring-billing concept used here), so this stays
 * a single-provider interface rather than forcing a provider-neutral shape
 * that would leak Paystack-specific fields (planCode) into
 * CheckoutGateway's generic contract.
 */
export interface SubscriptionBillingGateway {
  readonly name: "paystack";
  initializeSubscription(input: InitializeSubscriptionInput): Promise<InitializedSubscriptionCheckout>;
  disableSubscription(input: DisableSubscriptionInput): Promise<void>;
}

export function getSubscriptionBillingGateway(): SubscriptionBillingGateway {
  return new PaystackSubscriptionBilling();
}
