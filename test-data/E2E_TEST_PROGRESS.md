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
| 7 | Store → Discounts | 🟢 | Create code discount works; "WELCOME10" (10%) persisted to `app.discounts` and listed Active. |
| 8 | Store → Inventory | 🟢 | UI renders; all 5 inventory endpoints (balances/locations/movements/transfers/counts) return 200. Empty because the sample product has tracking off. |
| 9 | Store → Vendors | 🟢 | Create vendor works; "Fresh Farms Produce" persisted to `app.parties` + `app.supplier_accounts`. |
| 10 | Store → Purchase orders | 🟢 | Backend create (201) + list (200) work; PO-2026-014 (₦180,000) persisted and shows in UI. See UX note below. |
| 11 | Store → Bookings | 🟡 | **Core backend built & verified**: `app.bookings` table (migration 0056) + `POST /store/bookings/reserve` (public, 201), `GET /store/bookings` (by product/order, 200), `PATCH /store/bookings/:id/status` (200) — full reserve→list→confirm lifecycle passes with the exact `ServiceBooking` shape. Remaining for the full `BookingsManager` UI: **availability profiles** + **event types** endpoints (see findings). |
| 12 | Store → Point of Sale | 🟢 | `GET /api/store/pos/analytics` **built & verified** (200) — POS-channel gross sales / orders / discounts / returns + daily chart. UI renders fully. |
| 13 | Orders | ⬜ | Not started |
| 14 | Payments | ⬜ | Not started |
| 15 | Customers | ⬜ | Not started |
| 16 | Banking | ⬜ | Not started |

## Next to test
➡️ Two backend builds queued: **POS analytics endpoint** (small) and **Bookings feature** (large — table+domain+4 endpoints). Then resume audit at **Module 13 — Orders**, 14 Payments, 15 Customers, 16 Banking.

> Testing note: keep the browser pane at its natural width (no viewport emulation) — an emulated-then-scaled viewport makes click coordinates miss, which looks like "buttons do nothing" but is a test-harness artifact, not an app bug.

## Bugs fixed this session (builds)
- **[POS analytics] ✅ built** — `GET /api/store/pos/analytics?store_id&range&business_id` now returns `{gross_sales, orders_count, discounts_total, returns_total, sales_chart[]}` (POS-channel = `app.sales_channels.kind='pos'`). In the `dashboard` domain.
- **[Bookings core] ✅ built** — migration `0056_app_bookings` (`app.bookings`, service-layer access control, documented no-RLS) + `bookings` domain with reserve (public)/list/status. Public reserve derives business from the active store; dashboard endpoints derive it from the member's `store.read`. Date columns returned as text to avoid UTC day-shift. Full lifecycle verified.

## Scheduling backend (availability + event types) ✅ built & verified
- Migration `0057_app_scheduling` — `app.availability_profiles` + `app.event_types` (JSONB-primary, service-layer access control).
- `scheduling` domain mounted:
  - `GET/POST /api/availability`, `PATCH/DELETE /api/availability/:id`, `POST /api/availability/:id/duplicate` — verified 200/201 (create, list, duplicate→"(copy)", update→inactive).
  - `GET/POST /api/scheduling/event-types`, `PATCH/DELETE /api/scheduling/event-types/:id` — verified (create Haircut 45min slug=haircut pay=500000, list).
- Responses match the FE `AvailabilityProfile` / `EventType` snake_case shapes.

## 🔴 Blocker for the Bookings SCREEN — frontend restore is incomplete
The 4 restored files (`BookingsManager`, `AvailabilityView`, `EventTypeList`, `AvailabilitySelector`) import **9 files that were deleted and NOT restored**, so the screen cannot compile regardless of the backend:
- `Store/Scheduling/EventTypeDetailsDrawer`, `Store/Scheduling/EventTypeForm`
- `Store/AvailabilityList`, `Store/AvailabilityDetails`, `Store/AvailabilityFormModal`
- `queries/scheduling/hooks`, `queries/scheduling/queryKeys`
- `contexts/ProUpgradeContext`, `components/Pro/ProFeatureGate`
Plus two that EXIST but at the wrong path (BookingsManager imports them from subfolders): `Store/EventTypeList` → `Store/Scheduling/EventTypeList`, `Store/AvailabilityView` → `Store/Availability/AvailabilityView`.
**Action for whoever continues:** restore those 9 files from the same source the other 4 came from, then the components compile against the now-complete backend. Target grouping: a `Store/Booking/` (or `Scheduling/` + `Availability/`) folder. Then wire `BookingsManager` into the Store→Bookings nav (`config/navigation.tsx` sub `bookings`), which currently falls back to the store overview.
- **[Bookings — Figma spec]** service creation → uses booking component: https://www.figma.com/design/mHjpXjEKSUPSMwFnYfo8gh/Scripe?node-id=2092-118809&m=dev
- **[Purchase orders — UX] "Add new product" in the PO line-item search navigates away** to the full 7-step product wizard, abandoning the in-progress PO. To add a PO line you need an existing purchasable item; there's no lightweight inline "add item" that keeps you on the PO. Backend is fine (create/list verified). _Frontend UX improvement, not a backend gap._ **Figma spec:** https://www.figma.com/design/mHjpXjEKSUPSMwFnYfo8gh/Scripe?node-id=4415-139423&m=dev — use this to align the PO screen / inline add-item flow.
- **[Units] `app.units` DB table is unused by the UI** — the Units page renders a static frontend catalogue (`utils/units.buildUnitFallback`) rather than the DB table. Cosmetic/architectural; not user-facing. _No action._

## Environment
- `PII_ENCRYPTION_KEY` generated (`openssl rand -base64 32`) and saved to `scripe-be/.env` — required for KYB/banking. ✅ (set a **different** key in production.)

## Bugs found & fixes (log)
1. **[Dashboard] `GET /api/dashboard/stats` → 404 (route missing).** The Overview page called a dashboard-stats endpoint that didn't exist on the backend (it silently fell back to client-side order math). **Fixed:** implemented a new `dashboard` domain (`scripe-be/src/domains/dashboard/*`) + mounted `/api/dashboard/stats`; aggregates captured-payment revenue + order/customer counts by period & currency. Verified 200 with correct shape.
2. **[Dashboard] "Failed to fetch pending approvals: No active business selected".** `usePendingApprovalsQuery` ran on first paint before the business store hydrated and threw. **Fixed:** gated the query with `enabled: !!businessId` and keyed it per business (`scripe-fe/src/queries/bills/hooks.ts`). Now fires with the business id → 200.
3. **[Login] Hydration mismatch warning on `/login`** (ScripeLogo font className hash differs SSR vs CSR). Cosmetic, dev-only; does not affect functionality. _Left as-is (low priority)._
4. **[Store overview / branch dashboard] `GET /api/store/analytics` → 400 (endpoint missing).** **Fixed:** added a store-scoped analytics endpoint to the `dashboard` domain, mounted at `/api/store/analytics`; returns `total_revenue`/`total_orders`/`total_customers`/`total_products` + per-location breakdown. Verified 200 (correctly counts the 1 product created).

---
_Last updated: 2026-09-26 — Modules 1–2 green; starting Store → Units._
