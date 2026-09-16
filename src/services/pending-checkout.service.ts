import { SupabaseClient } from "@supabase/supabase-js";
import { PaystackMetadata } from "../types/webhook";

const PENDING_CHECKOUT_TABLE = "pending_checkouts";

const PENDING_CHECKOUT_SELECT = [
  "id",
  "reference",
  "payment_type",
  "amount_kobo",
  "customer_email",
  "subaccount_code",
  "metadata",
  "status",
  "created_at",
  "expires_at",
].join(", ");

/**
 * Reference-prefix → payment-type fallback when metadata.transaction_type is
 * absent (stripped by Paystack on bank-transfer charges). FlutterwaveProvider
 * prefixes every reference with "FLW-", so both forms are listed. Booking,
 * form and paid store checkouts pass no reference (Paystack generates one) and
 * always carry transaction_type in their metadata, so they need no prefix.
 */
const REFERENCE_PREFIX_PAYMENT_TYPES: Array<[string, string]> = [
  ["EVT-", "event_ticket"],
  ["FLW-EVT-", "event_ticket"],
  ["TIP-", "tipping"],
  ["FLW-TIP-", "tipping"],
  ["CIRCLE-", "circle_plan_subscription"],
  ["FLW-CIRCLE-", "circle_plan_subscription"],
  ["HILAQ-SUB-", "subscription"],
  ["FLW-HILAQ-SUB-", "subscription"],
  ["COURSE-", "course_purchase"],
  ["FLW-COURSE-", "course_purchase"],
  ["COHORT-", "cohort_enrollment"],
  ["FLW-COHORT-", "cohort_enrollment"],
  ["SCHED_", "scheduling_payment"],
  ["FLW-SCHED_", "scheduling_payment"],
];

export interface PendingCheckout {
  id: string;
  reference: string;
  payment_type: string;
  amount_kobo: number;
  customer_email: string;
  subaccount_code: string | null;
  metadata: PaystackMetadata;
  status: "pending" | "fulfilled" | "abandoned";
  created_at: string;
  expires_at: string;
}

export interface SavePendingCheckoutParams {
  reference: string;
  paymentType: string;
  amountKobo: number;
  customerEmail: string;
  subaccountCode?: string;
  metadata: PaystackMetadata;
}

class PendingCheckoutService {
  async save(
    client: SupabaseClient,
    params: SavePendingCheckoutParams,
  ): Promise<void> {
    const { error } = await client.from(PENDING_CHECKOUT_TABLE).insert({
      reference: params.reference,
      payment_type: params.paymentType,
      amount_kobo: params.amountKobo,
      customer_email: params.customerEmail,
      subaccount_code: params.subaccountCode ?? null,
      metadata: params.metadata,
    });
    if (error) throw new Error(error.message);
  }

  async findByReference(
    client: SupabaseClient,
    reference: string,
  ): Promise<PendingCheckout | null> {
    const { data, error } = await client
      .from(PENDING_CHECKOUT_TABLE)
      .select(PENDING_CHECKOUT_SELECT)
      .eq("reference", reference)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as PendingCheckout | null) ?? null;
  }

  async markFulfilled(
    client: SupabaseClient,
    reference: string,
  ): Promise<void> {
    const { error } = await client
      .from(PENDING_CHECKOUT_TABLE)
      .update({ status: "fulfilled" })
      .eq("reference", reference);
    if (error) throw new Error(error.message);
  }

  async updateMetadata(
    client: SupabaseClient,
    reference: string,
    metadata: PaystackMetadata,
  ): Promise<void> {
    const { error } = await client
      .from(PENDING_CHECKOUT_TABLE)
      .update({ metadata })
      .eq("reference", reference);
    if (error) throw new Error(error.message);
  }

  /**
   * Mark expired pending rows as abandoned — unless an order already exists for
   * the reference (late VA settlements may land after expiry, and the webhook
   * marks those fulfilled once the order is created).
   */
  async markExpiredAsAbandoned(
    client: SupabaseClient,
    nowIso: string,
  ): Promise<number> {
    const { data: expiredRows, error: expiredError } = await client
      .from(PENDING_CHECKOUT_TABLE)
      .select("reference")
      .eq("status", "pending")
      .lt("expires_at", nowIso)
      .limit(500);
    if (expiredError) throw new Error(expiredError.message);

    const expiredReferences = (expiredRows ?? []).map(
      (row: { reference: string }) => row.reference,
    );
    if (expiredReferences.length === 0) return 0;

    const [{ data: orders }, { data: storeOrders }] = await Promise.all([
      client
        .from("orders")
        .select("payment_reference")
        .in("payment_reference", expiredReferences),
      client
        .from("store_orders")
        .select("payment_reference")
        .in("payment_reference", expiredReferences),
    ]);

    const fulfilledReferences = new Set<string>([
      ...(orders ?? []).map(
        (row: { payment_reference: string }) => row.payment_reference,
      ),
      ...(storeOrders ?? []).map(
        (row: { payment_reference: string }) => row.payment_reference,
      ),
    ]);

    const abandonedReferences = expiredReferences.filter(
      (reference) => !fulfilledReferences.has(reference),
    );
    if (abandonedReferences.length === 0) return 0;

    const { error: updateError } = await client
      .from(PENDING_CHECKOUT_TABLE)
      .update({ status: "abandoned" })
      .in("reference", abandonedReferences)
      .eq("status", "pending");
    if (updateError) throw new Error(updateError.message);

    return abandonedReferences.length;
  }
}

/** Derive the payment type from metadata, falling back to the reference prefix. */
export function derivePaymentType(
  metadata: PaystackMetadata,
  reference?: string,
): string {
  if (metadata.transaction_type) return metadata.transaction_type;
  const match = REFERENCE_PREFIX_PAYMENT_TYPES.find(([prefix]) =>
    reference?.startsWith(prefix),
  );
  return match?.[1] ?? "unknown";
}

/**
 * Persist a pending checkout without failing the initiate call when the write
 * fails — the reconciliation cron and admin recovery panel are the safety net.
 */
export async function persistPendingCheckoutQuietly(
  client: SupabaseClient | null,
  params: SavePendingCheckoutParams,
): Promise<void> {
  if (!client) {
    console.error(
      "[PendingCheckout] Admin client unavailable — skipping persist",
    );
    return;
  }
  try {
    await pendingCheckoutService.save(client, params);
  } catch (error) {
    console.error(
      `[PendingCheckout] Failed to persist checkout for reference ${params.reference}:`,
      error,
    );
  }
}

export const pendingCheckoutService = new PendingCheckoutService();
export default pendingCheckoutService;
