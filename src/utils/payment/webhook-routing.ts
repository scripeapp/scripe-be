/**
 * Declarative routing for Paystack webhook events.
 *
 * Ownership is decided by what the event DECLARES about itself — never by
 * incidental context fields. `metadata.business_id` is context that many
 * product payments carry (events, store, tipping…), so it must never be read
 * as "this charge is a business subscription".
 *
 * Route order:
 * 1. `metadata.transaction_type` — every payment flow stamps this at
 *    initiation (`event_ticket`, `store_purchase`, `business_subscription`,
 *    `tipping`, `course_purchase`, `cohort_enrollment`, `scheduling_payment`,
 *    `form_submission`, `booking_payment`). A typed payload always routes by
 *    its declared type.
 * 2. `data.subscription_code` — Paystack's own structural marker that a
 *    charge belongs to a subscription (recurring pulls). Untyped recurring
 *    charges initiated before transaction_type existed still land correctly.
 * 3. Lifecycle event names (`subscription.*`, direct-debit, invoice failure)
 *    are owned by the business-subscription handler only when they carry
 *    `business_id`; untyped lifecycle events belong to other subscribers
 *    (e.g. publications) and stay on the normal pipeline.
 */

export type PaystackEventRoute = "business_subscription" | "product";

const BUSINESS_SUBSCRIPTION_LIFECYCLE_EVENTS = new Set([
  "direct_debit.authorization.created",
  "invoice.payment_failed",
]);

interface PaystackEventEnvelope {
  event: string;
  data?: {
    subscription_code?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
}

function readTransactionType(
  metadata: Record<string, unknown> | null | undefined,
): string | undefined {
  const value = metadata?.transaction_type;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hasBusinessId(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return typeof metadata?.business_id === "string" && !!metadata.business_id;
}

export function classifyPaystackEvent(
  event: PaystackEventEnvelope,
): PaystackEventRoute {
  const metadata = event.data?.metadata ?? null;

  const transactionType = readTransactionType(metadata);
  if (transactionType) {
    return transactionType === "business_subscription"
      ? "business_subscription"
      : "product";
  }

  if (
    typeof event.data?.subscription_code === "string" &&
    event.data.subscription_code.length > 0
  ) {
    return "business_subscription";
  }

  const isLifecycleEvent =
    event.event.startsWith("subscription.") ||
    BUSINESS_SUBSCRIPTION_LIFECYCLE_EVENTS.has(event.event);

  if (isLifecycleEvent && hasBusinessId(metadata)) {
    return "business_subscription";
  }

  return "product";
}
