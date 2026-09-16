# MON-002 — Pricing & Packaging Strategy Report

_Date: 2026-07-14_

## Decisions locked (this session)

| Question | Answer |
|---|---|
| Primary goal for MON-002 | **Grow paying conversions** (more free → paid upgrades) |
| ₦1,000 go-live fee (MON-001) vs. lower entry | **Drop it — monetize the transaction instead** |
| Ground gating in data | **Yes — run the analysis now** |

---

## ⚠️ Headline finding: your upgrade-signal instrumentation is silently dead

The `plan_upgrade_signals` **table does not exist** in the database `surge-be/.env` points at
(verified 2026-07-14 — `.select()` errors `42P01 "relation does not exist"`; ~248 businesses /
2,159 subscriptions, so likely production — **confirm it's not staging**).

- Migration [`20260309000003_plan_upgrade_signals.sql`](../supabase/migrations/20260309000003_plan_upgrade_signals.sql)
  was written but **never applied**.
- `recordLimitHit` wraps every write in a try/catch that swallows the error by design
  (_"Non-blocking — never interrupt the main request flow"_,
  [`upgrade-signals.service.ts:96`](../src/services/upgrade-signals.service.ts)).
- Result: every limit-hit has been throwing and getting silently discarded for months.
  The admin "Upgrade Signals" dashboard has been reading an empty/erroring table the whole time.

**Implication:** the data-driven gating step cannot run yet — there is nothing to query.
Fixing collection is therefore the actual first step of MON-002, not a side detail.

---

## Current state of the plan system

Three plans — Starter (Free) → Plus (₦4,000/mo) → Pro (₦7,500/mo)
([`surge-fe/src/config/pricingPlans.ts`](../../surge-fe/src/config/pricingPlans.ts)).

Two gating axes:
- **Limits** (quantity caps): publications, _free_ products, team_members, website_pages,
  segments, emails/month, forms.
- **Access** (on/off): courses, memberships, advanced_page_builder, custom_domain,
  custom_roles, advanced_analytics, import_contacts, email/priority support.

Two things already done right — keep them:
1. **Only _free_ products are capped; paid products are unlimited on every plan**
   ([`plan-limits.service.ts:160`](../src/services/plan-limits.service.ts)). Never blocks a
   merchant from listing revenue-generating inventory.
2. **Demand is instrumented** via `plan_upgrade_signals` — the intent is right; the table just
   was never migrated (see headline finding).

One big untapped lever: **transaction fee is a flat 3% + ₦100 on all three plans**
([`pricingPlans.ts:22`](../../surge-fe/src/config/pricingPlans.ts)).

---

## Strategy framework — gate on intent & scale, not on core commerce

Sort every feature into three buckets:

- **Bucket 1 — Never gate (the hook).** Anything needed for a first-time merchant's _first sale_:
  store, events, digital downloads, unlimited paid products, checkout, basic order management.
  This is the acquisition engine; gating it raises entry friction.
- **Bucket 2 — Gate by quantity (the growth tax).** Things a _successful_ merchant naturally needs
  more of: email volume, segments, team seats, newsletters, forms, website pages. Already the
  limit-based caps — correct shape (only bites once succeeding). Pushes **Starter → Plus**.
- **Bucket 3 — Gate by capability (the professionalization jump).** Whole capabilities that signal
  "real operation": courses, memberships, custom domain, custom roles, advanced analytics, import
  contacts, advanced page builder. Pushes **Plus → Pro**.

Rule of thumb: **quantity limits push Starter→Plus; capability gates push Plus→Pro.**

---

## The three sub-problems, answered

### 1. What to gate and where → use the signal data (once collecting)
`resolved_at` is stamped when a business **upgrades** (`UpgradeSignalsService.resolveSignals`), so:
- **resolved** rows = "hit this limit, then paid" = a **converting** gate → keep / tighten.
- **unresolved**, high-volume rows = friction that isn't converting → loosen or move up a tier.
- **never-hit** limits = doing no pricing work → reclaim into a lower tier at zero conversion cost.

### 2. Lower the entry barrier
- Keep Starter genuinely useful to first sale (it already is).
- **Drop the ₦1,000 go-live fee** — it directly contradicts "lower the barrier." Monetize via the
  transaction fee, which scales with merchant success instead of taxing intent.
- Give away the "dead gate" capacity on Starter — widens the funnel at no conversion cost.

### 3. What to upsell (ranked)
1. **Tiered transaction fees (highest leverage, currently unused).** Make the fee _drop_ as the
   plan rises — e.g. 3% Starter → 2% Plus → 1% Pro. Self-justifying: a merchant doing ₦500k/mo
   saves ₦5,000/mo by moving to a ₦4,000 plan, so the plan pays for itself. Aligns Hilaq revenue
   with merchant GMV; a pattern merchants already understand. Likely does more for MON-002 than
   the cycle restructuring itself.
2. **Capability unlocks with visible teaser state** (`LockedPostCard`, `ProFeatureGate` already
   exist) — courses, custom domain, analytics shown locked in-context.
3. **Custom domain (BRD-001)** — high perceived value, low marginal cost → strong Pro anchor.
4. **Advanced analytics (STR-001/STR-002)** — basic overview on all plans, advanced (cohorts,
   trends, abandoned-checkout recovery) gated to Pro.

---

## Revised sequencing

**Do now — no data required:**
1. **Fix the instrumentation** — apply the `plan_upgrade_signals` migration, then verify a write
   actually lands. (Confirm first whether that `.env` is prod or staging.) This is the true
   prerequisite for every future pricing decision.
2. **Drop the flat go-live fee + design the tiered transaction-fee ladder** (3%/2%/1%). Zero data
   needed to decide; this is the conversion engine given the "grow conversions + frictionless
   entry" goals.
3. **Apply the bucket framework** to re-sort features across Starter / Plus / Pro.

**Do in ~3–4 weeks — needs collected data:**
4. Run the analysis → tune exact caps → **then** the 3/6/12 billing-cycle restructuring
   (original MON-002 scope). Doing cycles first would repackage gates that haven't been validated.

---

## Artifacts produced

- Analysis (SQL, for Supabase SQL editor):
  [`surge-be/supabase/analysis/mon-002-gate-effectiveness.sql`](../supabase/analysis/mon-002-gate-effectiveness.sql)
- Analysis (runnable script, computes the same in JS):
  [`surge-be/src/scripts/analyze-upgrade-signals.ts`](../src/scripts/analyze-upgrade-signals.ts)
  — currently returns nothing because the table is unmigrated (see headline finding).

## Open items

- Confirm whether `surge-be/.env` targets production or staging.
- Apply the `plan_upgrade_signals` migration + write-verification.
- Draft the tiered transaction-fee model (fee ladder + break-even GMV per plan + framing copy).
