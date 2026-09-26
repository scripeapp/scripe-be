# Sprout Meals — End-to-End Test Progress

Tracking doc so anyone can continue from where testing stopped. Test data: [`sprout-meals.seed.json`](./sprout-meals.seed.json).

## How to run
- Backend: `cd scripe-be && bun run dev` (uses local `scripe_dev`, migrated to `0055`) → http://localhost:4000
- Frontend: `cd scripe-fe && bun run dev` → http://localhost:3000
- Login: `abdulsalamabodunrin369@gmail.com` / `abdulsalam123`
- Business under test: **Sprout Meals** (`28533ce1-e540-4cea-a721-f76c954bc50e`)

## Status legend
🟢 fully working (verified after any fixes) · 🟡 in progress / partial · 🔴 blocked/bug found · ⬜ not started

## Module status
| # | Module | Status | One-liner |
|---|--------|--------|-----------|
| 1 | Auth — login | 🟢 | Email/password login works; lands on dashboard. |
| 2 | Home / Dashboard | 🟢 | Renders with live stats after fixes; overview + approvals both 200. |
| 3 | Store → Units | 🟢 | Lists all 25 standard units grouped by type with per-unit product usage (read-only catalogue by design). |
| 4 | Store → Categories | 🟢 | Create category works end-to-end; "Bowls" persisted to `app.categories` and listed. |
| 5 | Store → Modifiers | 🟢 | Create modifier group works; "Choose your protein" persisted to `app.modifier_groups`. |
| 6 | Store → Products | 🟢 | Full 7-step F&B product wizard → publish works; product + variant + price (₦3,500 = 350000 minor NGN) persisted and listed. |
| 7 | Store → Discounts | ⬜ | Not started |
| 8 | Store → Inventory | ⬜ | Not started |
| 9 | Store → Vendors | ⬜ | Not started |
| 10 | Store → Purchase orders | ⬜ | Not started |
| 11 | Store → Bookings | ⬜ | Not started |
| 12 | Store → Point of Sale | ⬜ | Not started |
| 13 | Orders | ⬜ | Not started |
| 14 | Payments | ⬜ | Not started |
| 15 | Customers | ⬜ | Not started |
| 16 | Banking | ⬜ | Not started |

## Next to test
➡️ **Module 7 — Store → Discounts** (then proceed down the table).

> Testing note: keep the browser pane at its natural width (no viewport emulation) — an emulated-then-scaled viewport makes click coordinates miss, which looks like "buttons do nothing" but is a test-harness artifact, not an app bug.

## Open findings (not yet fixed)
- **[Store overview / branch dashboard] `GET /api/store/analytics` returns 400 (endpoint not implemented).** Same class of gap as bug #1 — the store overview's gross-sales and the branch-scoped dashboard numbers read from a `/store/analytics` route that the backend doesn't have, so they show ₦0. Not blocking (degrades to zero). **Fix path:** implement a store-scoped analytics endpoint mirroring the new `dashboard` domain (revenue + order/customer counts filtered by `store_id`, plus a `locations` breakdown). _Deferred to keep testing moving; documented for pickup._
- **[Units] `app.units` DB table is unused by the UI** — the Units page renders a static frontend catalogue (`utils/units.buildUnitFallback`) rather than the DB table. Cosmetic/architectural; not user-facing. _No action._

## Bugs found & fixes (log)
1. **[Dashboard] `GET /api/dashboard/stats` → 404 (route missing).** The Overview page called a dashboard-stats endpoint that didn't exist on the backend (it silently fell back to client-side order math). **Fixed:** implemented a new `dashboard` domain (`scripe-be/src/domains/dashboard/*`) + mounted `/api/dashboard/stats`; aggregates captured-payment revenue + order/customer counts by period & currency. Verified 200 with correct shape.
2. **[Dashboard] "Failed to fetch pending approvals: No active business selected".** `usePendingApprovalsQuery` ran on first paint before the business store hydrated and threw. **Fixed:** gated the query with `enabled: !!businessId` and keyed it per business (`scripe-fe/src/queries/bills/hooks.ts`). Now fires with the business id → 200.
3. **[Login] Hydration mismatch warning on `/login`** (ScripeLogo font className hash differs SSR vs CSR). Cosmetic, dev-only; does not affect functionality. _Left as-is (low priority)._

---
_Last updated: 2026-09-26 — Modules 1–2 green; starting Store → Units._
