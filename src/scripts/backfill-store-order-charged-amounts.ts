import "dotenv/config";
import supabaseAdmin from "../config/supabaseAdmin";

/**
 * Backfill store_orders charge-truth columns for foreign-currency orders:
 *
 *   charged_currency / charged_net_total — buyer charge minus gateway fee.
 *   The fee comes from webhook_logs (fee_actual, recorded since the true-up
 *   change). Historical transactions predating that logging can pass the fee
 *   manually:  --fee <reference>=<amount_in_major_units>  (repeatable).
 *   Rows with no fee available are reported and skipped rather than stored
 *   inflated.
 *
 * Also backfills payment_provider on every order missing it, preferring the
 * checkout snapshot's metadata.payment_provider and falling back to the
 * reference prefix once (CASH-/MANUAL- → cash).
 *
 * Dry-run by default; pass --apply to write updates.
 */

const APPLY = process.argv.includes("--apply");

const FEE_OVERRIDES = new Map<string, number>(
  process.argv
    .filter((arg) => arg.startsWith("--fee="))
    .map((arg) => {
      const [reference, fee] = arg.slice("--fee=".length).split("=");
      return [reference, Number(fee)];
    }),
);

type PendingRow = {
  reference: string;
  amount_kobo: number;
  metadata: { currency?: string } | null;
};

type OrderRow = {
  id: string;
  order_number: string;
  currency: string;
  total: number;
};

function providerFromReference(reference: string): "paystack" | "flutterwave" | "cash" {
  if (reference.startsWith("CASH-") || reference.startsWith("MANUAL-")) return "cash";
  if (reference.startsWith("FLW-")) return "flutterwave";
  return "paystack";
}

async function backfillPaymentProviders(): Promise<void> {
  const PAGE = 200;
  let from = 0;
  let scanned = 0;
  let updated = 0;

  while (true) {
    const { data: orders, error } = await supabaseAdmin!
      .from("store_orders")
      .select("id, order_number, payment_reference, payment_provider")
      .is("payment_provider", null)
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!orders || orders.length === 0) break;

    for (const order of orders as Array<{
      id: string;
      order_number: string;
      payment_reference: string;
      payment_provider: string | null;
    }>) {
      scanned += 1;

      const { data: checkouts } = await supabaseAdmin!
        .from("pending_checkouts")
        .select("metadata->payment_provider")
        .eq("reference", order.payment_reference)
        .maybeSingle();
      const snapshotProvider = (
        checkouts as { payment_provider?: string } | null
      )?.payment_provider;

      const provider =
        snapshotProvider === "flutterwave" || snapshotProvider === "paystack"
          ? snapshotProvider
          : providerFromReference(order.payment_reference);

      console.log(`- ${order.order_number}: payment_provider = ${provider}`);
      if (!APPLY) continue;

      const { error: updateError } = await supabaseAdmin!
        .from("store_orders")
        .update({ payment_provider: provider })
        .eq("id", order.id);
      if (updateError) throw updateError;
      updated += 1;
    }

    if (orders.length < PAGE) break;
    from += PAGE;
  }

  console.log(
    `Provider pass: ${scanned} order(s) scanned, ${updated} updated.`,
  );
}

async function fetchForeignCheckouts(): Promise<PendingRow[]> {
  if (!supabaseAdmin) {
    throw new Error(
      "supabaseAdmin is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.",
    );
  }

  const all: PendingRow[] = [];
  const PAGE = 200;
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("pending_checkouts")
      .select("reference, amount_kobo, metadata")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...(data as PendingRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }

  return all.filter((row) => {
    const currency = row.metadata?.currency?.toUpperCase();
    return currency && currency !== "NGN";
  });
}

/** Gateway fee in minor units from webhook_logs fee_actual or CLI override. */
async function resolveGatewayFeeKobo(
  reference: string,
): Promise<{ kobo: number | null; source: string }> {
  if (FEE_OVERRIDES.has(reference)) {
    return { kobo: Math.round(FEE_OVERRIDES.get(reference)! * 100), source: "cli-override" };
  }

  const { data } = await supabaseAdmin!
    .from("webhook_logs")
    .select("payload")
    .eq("reference", reference)
    .order("created_at", { ascending: false })
    .limit(1);
  const payload = data?.[0]?.payload as { fee_actual?: number } | undefined;
  if (typeof payload?.fee_actual === "number") {
    return { kobo: payload.fee_actual, source: "webhook_logs" };
  }
  return { kobo: null, source: "unavailable" };
}

async function main(): Promise<void> {
  const checkouts = await fetchForeignCheckouts();
  console.log(
    `Found ${checkouts.length} foreign-currency checkout(s). Mode: ${APPLY ? "APPLY" : "DRY RUN"}`,
  );

  let updated = 0;

  for (const checkout of checkouts) {
    const chargedCurrency = checkout.metadata?.currency!.toUpperCase();

    const { data: orders, error } = await supabaseAdmin!
      .from("store_orders")
      .select("id, order_number, currency, total")
      .eq("payment_reference", checkout.reference);
    if (error) throw error;

    if (!orders || orders.length === 0) {
      console.log(`- ${checkout.reference}: no store_order (skipped)`);
      continue;
    }

    for (const order of orders as OrderRow[]) {
      const gross = Number((checkout.amount_kobo / 100).toFixed(2));
      const { kobo: feeKobo, source } = await resolveGatewayFeeKobo(
        checkout.reference,
      );

      if (feeKobo == null) {
        console.log(
          `- ${order.order_number} (${checkout.reference}): gross ${gross} ${chargedCurrency}, ` +
            `fee unavailable — skipped (pass --fee=${checkout.reference}=<fee>)`,
        );
        continue;
      }

      const net = Number(((checkout.amount_kobo - feeKobo) / 100).toFixed(2));
      console.log(
        `- ${order.order_number} (${checkout.reference}): ` +
          `${order.total} ${order.currency} -> net ${net} ${chargedCurrency} ` +
          `(gross ${gross} - fee ${feeKobo / 100} via ${source})`,
      );
      if (!APPLY) continue;

      const { error: updateError } = await supabaseAdmin!
        .from("store_orders")
        .update({
          charged_currency: chargedCurrency,
          charged_net_total: net,
        })
        .eq("id", order.id);
      if (updateError) throw updateError;
      updated += 1;
    }
  }

  console.log(APPLY ? `Done. ${updated} row(s) updated.` : "Dry run only — rerun with --apply to write.");
}

async function run(): Promise<void> {
  await main();
  await backfillPaymentProviders();
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
