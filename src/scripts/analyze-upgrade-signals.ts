/**
 * MON-002 pre-work: analyze plan_upgrade_signals to decide gate placement.
 *
 * resolved_at is stamped when a business UPGRADES (UpgradeSignalsService.resolveSignals),
 * so resolved rows = "hit this limit, then paid" = per-gate conversion data.
 *
 * Run: npx ts-node src/scripts/analyze-upgrade-signals.ts
 * Read-only. Named columns only (egress).
 */
import { supabaseAdmin } from "../config/supabase";

type Row = {
  resource: string;
  current_plan: string;
  hit_count: number;
  first_hit_at: string;
  resolved_at: string | null;
};

const pct = (n: number, d: number) => (d ? ((100 * n) / d).toFixed(1) : "0.0");
const days = (a: string, b: string) =>
  (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;

async function fetchAll(): Promise<Row[]> {
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("plan_upgrade_signals")
      .select("resource, current_plan, hit_count, first_hit_at, resolved_at")
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data?.length) break;
    rows.push(...(data as Row[]));
    if (data.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const rows = await fetchAll();
  console.log(`\nTotal signals: ${rows.length}\n`);
  if (!rows.length) {
    console.log("No signals recorded yet — nothing to analyze.");
    return;
  }

  // 1) Conversion power per resource+plan
  const key = (r: Row) => `${r.current_plan} · ${r.resource}`;
  const g = new Map<string, Row[]>();
  for (const r of rows) (g.get(key(r)) ?? g.set(key(r), []).get(key(r))!).push(r);

  console.log("=== 1. CONVERSION POWER (keep/tighten the high-rate gates) ===");
  console.log("plan · resource | hits | converted | conv% | avgHits");
  [...g.entries()]
    .map(([k, rs]) => {
      const conv = rs.filter((r) => r.resolved_at).length;
      const avgHits = rs.reduce((a, r) => a + r.hit_count, 0) / rs.length;
      return { k, hits: rs.length, conv, rate: +pct(conv, rs.length), avgHits };
    })
    .sort((a, b) => b.rate - a.rate)
    .forEach((x) =>
      console.log(
        `${x.k} | ${x.hits} | ${x.conv} | ${x.rate}% | ${x.avgHits.toFixed(1)}`,
      ),
    );

  // 2) Friction without payoff (loosen / move up a tier)
  console.log("\n=== 2. FRICTION WITHOUT PAYOFF (unresolved, ≥3 businesses) ===");
  console.log("plan · resource | stuck | totalHits | avgHits | worst");
  const stuck = new Map<string, Row[]>();
  for (const r of rows.filter((r) => !r.resolved_at))
    (stuck.get(key(r)) ?? stuck.set(key(r), []).get(key(r))!).push(r);
  [...stuck.entries()]
    .filter(([, rs]) => rs.length >= 3)
    .map(([k, rs]) => ({
      k,
      n: rs.length,
      total: rs.reduce((a, r) => a + r.hit_count, 0),
      avg: rs.reduce((a, r) => a + r.hit_count, 0) / rs.length,
      worst: Math.max(...rs.map((r) => r.hit_count)),
    }))
    .sort((a, b) => b.total - a.total)
    .forEach((x) =>
      console.log(`${x.k} | ${x.n} | ${x.total} | ${x.avg.toFixed(1)} | ${x.worst}`),
    );

  // 3) Time-to-convert (build nudges around the fastest triggers)
  console.log("\n=== 3. TIME-TO-CONVERT (fast = strong buying trigger) ===");
  console.log("plan · resource | conversions | avgDaysToUpgrade");
  [...g.entries()]
    .map(([k, rs]) => {
      const c = rs.filter((r) => r.resolved_at);
      const avgD = c.length
        ? c.reduce((a, r) => a + days(r.resolved_at!, r.first_hit_at), 0) / c.length
        : NaN;
      return { k, conv: c.length, avgD };
    })
    .filter((x) => x.conv > 0)
    .sort((a, b) => a.avgD - b.avgD)
    .forEach((x) => console.log(`${x.k} | ${x.conv} | ${x.avgD.toFixed(1)}d`));

  // 4) Dead gates (rarely hit → give away on Starter, no conversion cost)
  console.log("\n=== 4. DEAD GATES (lowest total hits — reclaim to lower entry) ===");
  const byRes = new Map<string, number>();
  for (const r of rows) byRes.set(r.resource, (byRes.get(r.resource) ?? 0) + r.hit_count);
  [...byRes.entries()]
    .sort((a, b) => a[1] - b[1])
    .forEach(([res, hits]) => console.log(`${res} | ${hits} total hits`));

  // 5) Pressure by plan
  console.log("\n=== 5. PRESSURE BY PLAN (where the squeeze concentrates) ===");
  const byPlan = new Map<string, Row[]>();
  for (const r of rows)
    (byPlan.get(r.current_plan) ?? byPlan.set(r.current_plan, []).get(r.current_plan)!).push(r);
  [...byPlan.entries()]
    .map(([p, rs]) => ({
      p,
      n: rs.length,
      conv: rs.filter((r) => r.resolved_at).length,
    }))
    .sort((a, b) => b.n - a.n)
    .forEach((x) => console.log(`${x.p} | ${x.n} signals | ${x.conv} converted | ${pct(x.conv, x.n)}%`));

  console.log("");
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
