import "dotenv/config";
import axios from "axios";
import supabaseAdmin from "../config/supabaseAdmin";
import { fetchPaystackSubaccount, listBanks } from "../utils/paystack.util";
import { createFlutterwaveSubaccount } from "../utils/flutterwave.util";

const BATCH_SIZE = Number(process.env.BACKFILL_BATCH_SIZE || 50);
const DRY_RUN = process.argv.includes("--dry-run");
// Pause between FLW API calls to avoid rate-limiting
const DELAY_MS = 500;

type BusinessRow = {
  id: string;
  name: string | null;
  owner_user_id: string | null;
  paystack_subaccount_code: string;
  flw_subaccount_id: string | null;
};

async function fetchCandidates(): Promise<BusinessRow[]> {
  if (!supabaseAdmin) {
    throw new Error(
      "supabaseAdmin is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.",
    );
  }

  const all: BusinessRow[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("businesses")
      .select("id, name, owner_user_id, paystack_subaccount_code, flw_subaccount_id")
      .not("paystack_subaccount_code", "is", null)
      .is("flw_subaccount_id", null)
      .order("created_at", { ascending: true })
      .range(from, from + BATCH_SIZE - 1);

    if (error) throw error;

    const rows = (data || []) as BusinessRow[];
    if (rows.length === 0) break;

    all.push(...rows);
    if (rows.length < BATCH_SIZE) break;
    from += BATCH_SIZE;
  }

  return all;
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function backfill() {
  console.log(
    `Starting FLW subaccount backfill (dryRun=${DRY_RUN}, batchSize=${BATCH_SIZE})`,
  );

  const candidates = await fetchCandidates();
  console.log(
    `Found ${candidates.length} business(es) with Paystack subaccount but no FLW subaccount.`,
  );

  if (candidates.length === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  // Build name → CBN code map from Paystack's bank list.
  // Paystack subaccount GET returns bank names in settlement_bank, not codes.
  // CBN codes are identical on Paystack and FLW for NG banks.
  console.log("Fetching Paystack bank list to resolve bank codes…");
  const paystackBanks = await listBanks();
  const bankCodeByName = new Map(paystackBanks.map((b) => [b.name.toLowerCase(), b.code]));
  console.log(`  ${paystackBanks.length} banks loaded.`);

  let created = 0;
  let skipped = 0;
  let failed = 0;

  for (const biz of candidates) {
    const label = `[${biz.id}] "${biz.name ?? "unnamed"}"`;

    // Fetch account details from Paystack (settlement_bank + account_number)
    let paystackDetails: { settlement_bank: string; account_number: string; business_name: string };
    try {
      paystackDetails = await fetchPaystackSubaccount(biz.paystack_subaccount_code);
    } catch (err: any) {
      console.error(`${label} — could not fetch Paystack subaccount: ${err.message}`);
      failed += 1;
      continue;
    }

    const { settlement_bank, account_number, business_name } = paystackDetails;

    if (!settlement_bank || !account_number) {
      console.log(`${label} — SKIP: missing settlement_bank or account_number`);
      skipped += 1;
      continue;
    }

    // Paystack returns bank name in settlement_bank; resolve to CBN code for FLW.
    const bankCode = bankCodeByName.get(settlement_bank.toLowerCase());
    if (!bankCode) {
      console.log(`${label} — SKIP: could not resolve bank code for "${settlement_bank}"`);
      skipped += 1;
      continue;
    }

    const bizName = business_name || biz.name || "Business";

    console.log(
      `${label} — ${DRY_RUN ? "[DRY RUN] would create" : "creating"} FLW subaccount` +
        ` (bank: ${settlement_bank} [${bankCode}], account: ${account_number})`,
    );

    if (DRY_RUN) {
      created += 1;
      continue;
    }

    try {
      // Resolve owner email from auth.users
      let ownerEmail = "";
      if (biz.owner_user_id) {
        const { data: { user } } = await supabaseAdmin!.auth.admin.getUserById(biz.owner_user_id);
        ownerEmail = user?.email ?? "";
      }

      const flwSub = await createFlutterwaveSubaccount({
        account_number,
        account_bank: bankCode,
        business_name: bizName,
        country: "NG",
        business_email: ownerEmail,
      });

      const { error: updateErr } = await supabaseAdmin!
        .from("businesses")
        .update({ flw_subaccount_id: flwSub.id, flw_country: "NG" })
        .eq("id", biz.id);

      if (updateErr) throw updateErr;

      console.log(`${label} — OK: flw_subaccount_id=${flwSub.id}`);
      created += 1;
    } catch (err: any) {
      const flwError: string = err?.response?.data?.message ?? err.message ?? "";

      // FLW already has a subaccount for this account+bank — fetch and store it.
      if (flwError.toLowerCase().includes("already exists")) {
        try {
          const flwKey = process.env.FLW_SECRET_KEY!;
          const res = await axios.get(
            `https://api.flutterwave.com/v3/subaccounts?account_number=${account_number}&account_bank=${bankCode}`,
            { headers: { Authorization: `Bearer ${flwKey}` }, timeout: 10_000 },
          );
          const existing = res.data?.data?.[0];
          if (existing?.id) {
            const { error: updateErr } = await supabaseAdmin!
              .from("businesses")
              .update({ flw_subaccount_id: existing.id, flw_country: "NG" })
              .eq("id", biz.id);
            if (updateErr) throw updateErr;
            console.log(`${label} — RECOVERED existing FLW subaccount: id=${existing.id}`);
            created += 1;
            continue;
          }
        } catch (recoverErr: any) {
          console.error(`${label} — recovery fetch failed: ${recoverErr.message}`);
        }
      }

      console.error(`${label} — FAILED: ${flwError}`);
      failed += 1;
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `\nDone. created=${created} skipped=${skipped} failed=${failed}` +
      (DRY_RUN ? " (dry run — no changes written)" : ""),
  );
}

backfill().catch((err) => {
  console.error("Backfill error:", err);
  process.exit(1);
});
