import "dotenv/config";
import supabaseAdmin from "../config/supabaseAdmin";
import {
  buildOrderAccountingPatch,
  deriveDiscountEvidence,
  extractCouponRules,
  extractSubmittedCoupon,
  resolveAttribution,
  round2,
  type CouponRule,
  type DerivedDiscountEvidence,
} from "../utils/event-pricing-accounting";

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 200);
const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const LIMIT = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const refArg = process.argv.find((arg) => arg.startsWith("--reference="));
const REFERENCE = refArg ? refArg.split("=")[1].trim() : null;
const TOLERANCE = 0.05;

interface SnapshotRow {
  reference: string;
  event_id: string;
  breakdown: unknown;
  base_total: number;
  adjustment_total: number;
  currency: string;
}

interface OrderRow {
  id: string;
  payment_reference: string;
  total_amount: number | null;
}

async function fetchSnapshots(): Promise<SnapshotRow[]> {
  if (!supabaseAdmin) throw new Error("supabaseAdmin is not configured.");

  const all: SnapshotRow[] = [];
  let from = 0;

  while (all.length < LIMIT) {
    let query = supabaseAdmin
      .from("event_pricing_snapshots")
      .select(
        "reference, event_id, breakdown, base_total, adjustment_total, currency",
      )
      .order("created_at", { ascending: true });
    if (REFERENCE) query = query.eq("reference", REFERENCE);
    const { data, error } = await query.range(from, from + BATCH_SIZE - 1);

    if (error) throw error;

    const rows = (data || []) as SnapshotRow[];
    if (rows.length === 0) break;

    all.push(...rows.slice(0, Math.max(0, LIMIT - all.length)));
    if (rows.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }

  return all;
}

async function fetchOrders(references: string[]): Promise<OrderRow[]> {
  if (!supabaseAdmin) throw new Error("supabaseAdmin is not configured.");

  const all: OrderRow[] = [];
  for (let start = 0; start < references.length; start += BATCH_SIZE) {
    const chunk = references.slice(start, start + BATCH_SIZE);
    let query = supabaseAdmin
      .from("orders")
      .select("id, payment_reference, total_amount")
      .in("payment_reference", chunk);
    if (!FORCE) query = query.is("subtotal_amount", null);

    const { data, error } = await query;
    if (error) throw error;
    all.push(...((data || []) as OrderRow[]));
  }
  return all;
}

async function fetchInChunks<T>(
  table: string,
  columns: string,
  column: string,
  values: string[],
): Promise<T[]> {
  if (!supabaseAdmin) throw new Error("supabaseAdmin is not configured.");
  const all: T[] = [];
  for (let start = 0; start < values.length; start += BATCH_SIZE) {
    const chunk = values.slice(start, start + BATCH_SIZE);
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .in(column, chunk);
    if (error) throw error;
    all.push(...((data || []) as T[]));
  }
  return all;
}

async function main() {
  console.log(
    `Starting order discount-accounting backfill from event_pricing_snapshots` +
      ` (dryRun=${DRY_RUN}, force=${FORCE}, limit=${
        Number.isFinite(LIMIT) ? LIMIT : "none"
      }, reference=${REFERENCE ?? "all"}, batchSize=${BATCH_SIZE})`,
  );

  const snapshots = await fetchSnapshots();
  console.log(`Fetched ${snapshots.length} pricing snapshot(s).`);
  if (snapshots.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  const references = snapshots.map((s) => s.reference);

  const orders = await fetchOrders(references);
  const pendings = await fetchInChunks<{ reference: string; metadata: unknown }>(
    "pending_checkouts",
    "reference, metadata",
    "reference",
    references,
  );

  const eventIds = Array.from(new Set(snapshots.map((s) => s.event_id))).filter(
    Boolean,
  );
  const events = await fetchInChunks<{ id: string; pricing_rules: unknown }>(
    "events",
    "id, pricing_rules",
    "id",
    eventIds,
  );

  const snapshotByReference = new Map(snapshots.map((s) => [s.reference, s]));
  const metadataByReference = new Map(
    pendings.map((p) => [p.reference, p.metadata]),
  );
  const rulesByEventId = new Map(
    events.map((e) => [e.id, extractCouponRules(e.pricing_rules)]),
  );

  const targets = orders.map((order) => ({
    order,
    snapshot: snapshotByReference.get(order.payment_reference)!,
  }));

  console.log(
    `\n${targets.length} order(s) matched${
      FORCE ? "" : " (subtotal_amount IS NULL)"
    }.`,
  );

  const jobs: Array<{
    orderId: string;
    reference: string;
    patch: ReturnType<typeof buildOrderAccountingPatch>;
    totalAmount: number | null;
    attributedVia: string;
  }> = [];

  let skippedNoDiscount = 0;
  let unattributed = 0;

  for (const { order, snapshot } of targets) {
    const derived = deriveDiscountEvidence(snapshot);
    if (
      derived.discountAmount === 0 &&
      derived.surchargeAmount === 0 &&
      derived.subtotalAmount === null
    ) {
      skippedNoDiscount += 1;
      continue;
    }

    const couponRules = rulesByEventId.get(snapshot.event_id) ?? [];
    const submittedCode = extractSubmittedCoupon(
      metadataByReference.get(order.payment_reference),
    );
    const attribution = resolveAttribution(derived, submittedCode, couponRules);
    if (hasUnattributedDiscount(derived, attribution)) unattributed += 1;

    jobs.push({
      orderId: order.id,
      reference: order.payment_reference,
      patch: buildOrderAccountingPatch(snapshot, derived, attribution),
      totalAmount: order.total_amount,
      attributedVia: describeAttribution(derived, attribution),
    });
  }

  console.log(
    `${jobs.length} order(s) would receive an accounting patch` +
      ` (${skippedNoDiscount} skipped — nothing priced in snapshot` +
      `, ${unattributed} discount(s) without attributable code).\n`,
  );

  let shownMismatches = 0;
  for (const job of jobs.slice(0, DRY_RUN ? 30 : 5)) {
    const expected =
      (job.patch.subtotal_amount ?? 0) -
      job.patch.discount_amount +
      job.patch.surcharge_amount;
    const drift =
      job.totalAmount != null ? round2(expected - job.totalAmount) : null;
    if (drift !== null && Math.abs(drift) > TOLERANCE) shownMismatches += 1;
    console.log(
      `[${job.reference}] order=${job.orderId}` +
        ` subtotal=${job.patch.subtotal_amount}` +
        ` discount=${job.patch.discount_amount}` +
        ` surcharge=${job.patch.surcharge_amount}` +
        ` code=${job.patch.discount_code ?? "-"}` +
        ` details=${JSON.stringify(job.patch.discount_details)}` +
        ` total=${job.totalAmount ?? "-"}` +
        (drift !== null && Math.abs(drift) > TOLERANCE ? ` DRIFT=${drift}` : "") +
        ` via=${job.attributedVia}`,
    );
  }

  if (DRY_RUN) {
    console.log(
      "\nDry run complete — no changes written." +
        (jobs.length > 30 ? ` (${jobs.length - 30} more not shown)` : ""),
    );
    return;
  }

  if (!supabaseAdmin) throw new Error("supabaseAdmin is not configured.");

  let updated = 0;
  let failed = 0;

  for (const job of jobs) {
    const { error } = await supabaseAdmin
      .from("orders")
      .update(job.patch)
      .eq("id", job.orderId);
    if (error) {
      console.error(`[${job.reference}] FAILED: ${error.message}`);
      failed += 1;
      continue;
    }
    updated += 1;
  }

  console.log(`\nDone. updated=${updated} failed=${failed}.`);
}

function hasUnattributedDiscount(
  derived: DerivedDiscountEvidence,
  attribution: { code: string | null },
): boolean {
  return derived.discountAmount > 0 && !attribution.code;
}

function describeAttribution(
  derived: DerivedDiscountEvidence,
  attribution: { code: string | null; rule: CouponRule | null },
): string {
  if (derived.discountAmount <= 0) return "none";
  if (derived.breakdownCodes.length > 0) return "breakdown";
  if (attribution.rule) return "checkout-code+rule";
  if (attribution.code) return "checkout-code-only";
  return "unattributed";
}

main().catch((err) => {
  console.error("Backfill error:", err);
  process.exit(1);
});
