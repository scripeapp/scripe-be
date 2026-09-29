# Sprout Meals — End-to-End Test Progress

Tracking doc so anyone can continue from where testing stopped. Test data: [`sprout-meals.seed.json`](./sprout-meals.seed.json).

## How to run
- Backend: `cd scripe-be && bun run dev` (uses local `scripe_dev`, migrated to `0064`) → http://localhost:4000
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
| 11 | Store → Bookings | 🟡 | **Backend + FE page complete**: BE booking engine (evolved tables, slot engine, reserve/slots/list/status endpoints) + staff commission report. FE Bookings page built & wired (calendar day/week, quick book, list, status panel via `Bookings/` module), Store→Bookings **nav re-added**, obsolete scheduling-era UI files removed, FE `tsc --noEmit` clean + lint clean. Remaining: POS till slice (price resolution, order-from-booking, tips, deposits). |
| 12 | Store → Point of Sale | 🟢 | `GET /api/store/pos/analytics` **built & verified** (200) — POS-channel gross sales / orders / discounts / returns + daily chart. UI renders fully. **Till slice built (migration 0066 + POS domain + FE page)**: booking-order pricing (`POST /store/pos/order/preview|order`), order-from-booking with tips (`app.booking_tips`), deposits netted off tendered, commission report carries `tipsMinor`. Verified: `pos-till.integration.test.ts` (2 tests) + FE bookings panel/tip flow wired. |
| 13 | Orders | ⬜ | Not started |
| 14 | Payments | ⬜ | Not started |
| 15 | Customers | ⬜ | Not started |
| 16 | Banking | ⬜ | Not started |

## Next to test
➡️ Resume audit at **Module 13 — Orders**, 14 Payments, 15 Customers, 16 Banking. Bookings FE page is built & wired but not yet manually smoke-tested end-to-end (see "Service bookings — Phase 2" builder notes below); backend bookings + commission slices are fully tested.

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

## Scheduling FE query layer ✅ built & clean
`queries/scheduling/{queryKeys,api,hooks}.ts` — built against the new endpoints, **zero type errors**. Exports the surface the components import: `useSchedulingAvailabilityQuery`, `useSchedulingEventTypesQuery`, `useSchedulingBookingsQuery`, `useSeedSchedulingDefaultsMutation`, `type SchedulingBooking`, `schedulingKeys`. Also added `GET /api/scheduling/bookings` (returns `[]` — appointment persistence is a later step) so the hook resolves 200, not 404.

## 🔴 Remaining blocker — 7 pure-UI files still missing from the restore (down from 9)
The restored components still import UI files that were deleted and NOT restored (I can't recreate these to spec — they're complex drawers/forms/lists with no source available):
- `Store/Scheduling/EventTypeDetailsDrawer`, `Store/Scheduling/EventTypeForm`
- `Store/AvailabilityList`, `Store/AvailabilityDetails`, `Store/AvailabilityFormModal`
- `contexts/ProUpgradeContext`, `components/Pro/ProFeatureGate`
Plus two that EXIST but need MOVING (BookingsManager imports them from subfolders): `Store/EventTypeList` → `Store/Scheduling/EventTypeList`, `Store/AvailabilityView` → `Store/Availability/AvailabilityView`.
**To finish:** restore those 7 files from the same source the other 4 came from. Then the components compile against the (now complete) backend + query layer — remaining tsc errors are confined to `AvailabilityView`, `BookingsManager`, `EventTypeList` and are entirely these missing imports. Then: group into `Store/Booking/` and wire `BookingsManager` into the Store→Bookings nav (`config/navigation.tsx` sub `bookings`).
- **[Bookings — Figma spec]** service creation → uses booking component: https://www.figma.com/design/mHjpXjEKSUPSMwFnYfo8gh/Scripe?node-id=2092-118809&m=dev
- **[Purchase orders — UX] "Add new product" in the PO line-item search navigates away** to the full 7-step product wizard, abandoning the in-progress PO. To add a PO line you need an existing purchasable item; there's no lightweight inline "add item" that keeps you on the PO. Backend is fine (create/list verified). _Frontend UX improvement, not a backend gap._ **Figma spec:** https://www.figma.com/design/mHjpXjEKSUPSMwFnYfo8gh/Scripe?node-id=4415-139423&m=dev — use this to align the PO screen / inline add-item flow.
- **[Units] `app.units` DB table is unused by the UI** — the Units page renders a static frontend catalogue (`utils/units.buildUnitFallback`) rather than the DB table. Cosmetic/architectural; not user-facing. _No action._

## Environment
- `PII_ENCRYPTION_KEY` generated (`openssl rand -base64 32`) and saved to `scripe-be/.env` — required for KYB/banking. ✅ (set a **different** key in production.)

## Booking engine — Phase 1 (backend) ✅ built & verified
Per `docs/HANDOFF.md` track-2 / `docs/SERVICE_BOOKINGS_DESIGN.md`. A follow-on build to the 0056 bookings core: real staff slot scheduling.

- **Migrations** (applied to `scripe_dev`):
  - `0060_app_bookings_evolve` (+down) — new status lifecycle (`held/pending/confirmed/arrived/in_service/completed/cancelled/no_show`, maps `declined→cancelled`, `rescheduled→confirmed`), `startsAt/endsAt` timestamptz, `locationId`, `source`, `holdExpiresAt`, `manageToken`, `notes`, `cancelledReason`; backfills from old local-time columns.
  - `0061_app_booking_items` (+down) — `app.booking_items` (per-service interval row), **btree_gist exclusion constraint `booking_items_no_overlap`** (a staff can never hold two overlapping active items — the hard concurrency guarantee), `booking.read/create/update` permissions, RLS ON for bookings + items, read policies for the slot engine's tables, status-sync trigger, SECURITY DEFINER `app.reserve_booking_from_public`.
  - `0062/0063_app_booking_reserve*` (+downs) — fixed the definer function's PL/pgSQL OUT-column ambiguity (`RETURNING`/`DELETE` qualified with the table name).
  - `0064_app_drop_scheduling_prototype` (+down) — **replaced the 0057 scheduling prototype**: seeds each bookable staff member's week from the business's active `availability_profiles`, then drops `app.event_types` + `app.availability_profiles`. The `scheduling` domain (routes/controller/service/repository) was removed and unmounted from `app.ts`; `/api/scheduling/event-types*` and `/api/availability*` now 404. Codegen regenerated.
- **Domain**: `src/domains/bookings/*` rewritten — types (`ServiceBooking` snake_case + item `status`), schemas, repository (list/find/attach items/shift/update), `slots.ts` slot engine (calendar-day windows in the store timezone, weekly schedules, off-exceptions, padded occupied ranges, slot interval), service (reserve/list/status transitions/reschedule by shifting items/available slots), controller + routes (`/api/store/bookings/reserve` public; `/api/store/bookings`, `/slots`, `/:bookingId/status` behind `requireAuth` + `booking.*` permission).
- **Shared**: `src/shared/tz.ts` (+6 unit tests) — store-timezone instant math with two-pass DST handling.
- **Verification**: `bookings.integration.test.ts` (6 tests) → reserve, slots, list, reschedule, confirm (item status syncs via trigger), cancel (frees slot), 409 on double-book & parallel race (exactly one winner), inactive store 404, cross-tenant blocked. `src/db/scheduling-removal.migration.test.ts` (2 tests) → 0057 endpoints 404 + tables dropped. Full suite: **51 suites / 322 tests passing**, `tsc --noEmit` clean.
- **FE cleanup (design § Cleanup)**: Store → Bookings nav link hidden until Phase 2; leftover `dashboard.scheduling` / `scheduling.availability` agentPages entries removed; "New event type" header action removed. FE still at its documented blocked baseline (missing `Scheduling/*` / `Availability/*` UI files must be restored from git source during the Phase-2 build — do not fabricate).
- **Remaining (Phase 2)**: the Bookings page (calendar/quick-book/list/booking panel) + POS checkout, wired to the evolved endpoints; then Store → Bookings nav is re-added.

## Service bookings — Phase 2 (FE page) ✅ built & wired
Per `SERVICE_BOOKINGS_DESIGN.md` § Bookings page — the FE page is now wired to the live `/api/store/bookings/*` API. The POS-till slice (order-from-booking, pricing resolution, tips, deposits) remains.

**Backend slice that powers it (landed earlier):**
- **`0065_staff_commission`** (+down) — `staff_profiles.commissionPercent` (`smallint`, 0–100, default 0). RLS/grants already cover it via 0059.
- **Staff**: `commissionPercent` optional on create/update; `PATCH /api/businesses/:businessId/staff/:staffId` validates 0–100 (101 → 400).
- **Report**: `GET /api/businesses/:businessId/staff/commission-report?from&to` (`team.read`) — per staff: `revenueMinor` (sum `priceMinor` over `completed` `booking_items` with `endsAt` in range), `tipsMinor` (0 until till lands), `commissionMinor` (`round(revenue × percent ÷ 100)`), `completedBookings`. Verified end-to-end (full lifecycle held→…→completed, cross-tenant 403).

**FE bookings page:**

- **FE module**: `scripe-fe/src/components/Dashboard/Store/Bookings/` — `bookingsTypes.ts` (`ServiceBooking`/`AvailableSlot`/`ReservedBooking`/`StaffMember`/`ScheduleException` + `BOOKING_STATUS_META`), `bookingsTime.ts` (local-datetime/tz helpers + `localWallTimeToIso`), `bookingsApi.ts` (fetchBookings/fetchSlots/reserveBooking/updateBookingStatus/fetchStaff/fetchScheduleExceptions/formatPriceMinor), `BookingsCalendar.tsx` (day + week views, per-staff columns, business-hours + time-off-exception closed shading, status colours, click empty slot → quick-book prefill, click block → detail panel), `BookingsList.tsx` (today/upcoming/past/requests segments + staff/service/status filters), `QuickBookDrawer.tsx` (name/email/phone, service, staff, date, live slots; submits `POST /api/store/bookings/reserve`), `BookingDetailDrawer.tsx` (details, items & prices, status actions, cancel-reason, reschedule for held/pending with `starts_at`), `BookingsPage.tsx` (composition, location filter, refresh, auto-open created booking, listens for `open-quick-book` window event from the Dashboard header action).
- **Wiring**: `config/navigation.tsx` store subitem `bookings` + `CalendarClock` icon (nav re-added); `StoreOverview.tsx` `"bookings"` tab → renders `BookingsPage`; `Dashboard.tsx` header shows "New booking" on the bookings sub-page.
- **Cleanup**: deleted obsolete `Store/BookingsManager.tsx`, `Store/EventTypeList.tsx`, `Store/AvailabilityView.tsx` (verified zero importers). Kept `queries/scheduling/*` + `types/availability.ts` (still used by storefront calendar, product cards, `StoreCustomize`, `AddOrderModal`, `AvailabilitySelector`).
- **Conventions**: state set on open/load is deferred past the effect's synchronous phase via `yieldToMicrotaskQueue()` (repo `react-hooks/set-state-in-effect` rule); mutations go through `PATCH /api/store/bookings/:id/status` with the transition matrix from the design doc.
- **Verification**: `npx tsc --noEmit` → 0 errors outside stale `.next/types` artifacts; `npx eslint` on the new module + wired files → 0 errors (only 2 pre-existing `Dashboard.tsx` warnings). **Not yet manually smoke-tested** in-browser; run the calendar → quick-book → status-panel happy path when resuming audits.
- **Note**: reserves still hold `priceMinor = 0` (pricing resolution is part of the till build), so the commission report revenue is legitimately 0 for online bookings until the Phase 2 POS prices/charges them.

## Bugs found & fixes (log)
1. **[Dashboard] `GET /api/dashboard/stats` → 404 (route missing).** The Overview page called a dashboard-stats endpoint that didn't exist on the backend (it silently fell back to client-side order math). **Fixed:** implemented a new `dashboard` domain (`scripe-be/src/domains/dashboard/*`) + mounted `/api/dashboard/stats`; aggregates captured-payment revenue + order/customer counts by period & currency. Verified 200 with correct shape.
2. **[Dashboard] "Failed to fetch pending approvals: No active business selected".** `usePendingApprovalsQuery` ran on first paint before the business store hydrated and threw. **Fixed:** gated the query with `enabled: !!businessId` and keyed it per business (`scripe-fe/src/queries/bills/hooks.ts`). Now fires with the business id → 200.
3. **[Login] Hydration mismatch warning on `/login`** (ScripeLogo font className hash differs SSR vs CSR). Cosmetic, dev-only; does not affect functionality. _Left as-is (low priority)._
4. **[Store overview / branch dashboard] `GET /api/store/analytics` → 400 (endpoint missing).** **Fixed:** added a store-scoped analytics endpoint to the `dashboard` domain, mounted at `/api/store/analytics`; returns `total_revenue`/`total_orders`/`total_customers`/`total_products` + per-location breakdown. Verified 200 (correctly counts the 1 product created).

---
_Last updated: 2026-09-29 — POS till slice built (migration 0066 booking_tips, pos domain, till integration tests, FE bookings panel + tip flow); Store → Bookings FE page wired end-to-end. Remaining: Modules 13–16 + new-till manual smoke test._

## POS till slice — ✅ built & wired (2026-09-29)
Per `SERVICE_BOOKINGS_DESIGN.md` § Phase 2 (till). Pricing + tips + deposits now land end-to-end:
- **Migration `0066_app_booking_tips`** (+down): `app.booking_tips` (bookingId/businessId/staffId unique, FK to bookings/orders/staff, `amountMinor`), RLS `booking_tips_read/write` on `booking.read/update`, grants to `scripe_app`. Applied to dev DB (`db:migrate` → "Applied: 0066_app_booking_tips").
- **POS domain** `src/domains/pos/*`: `GET /api/store/pos/bookings` (today's arrived+in_service, store-tz day-bound), `POST /api/store/pos/order/preview` (item pricing → camelCase minor), `POST /api/store/pos/order` (booking XOR items; re-prices booking lines + additive items via `pricePosLines`, creates order `POS-…`, records payment = total+tip, completes booking + backfills `booking_items.priceMinor`, upserts tip). Idempotent per booking (replay returns existing summary). Shift/branch mismatch → 409.
- **Units**: backend returns minor everywhere; FE converts for display via `fromMinorUnits` (PosScreen + DevicePosPage preview).
- **Deposit/balance**: `deposit_paid = captured − this payment`; `balance_due = max(0, total + tip − captured)`.
- **Commission report**: `tipsMinor` added via correlated subquery on `booking_tips`; verified row `{revenueMinor: 4945, tipsMinor: 500, commissionMinor, completedBookings: 1}` in the till test.
- **FE**: PosScreen gains Menu/Bookings toggle + till bookings panel (60s poll, reload after charge); `usePosTicket.openBooking` materializes booked items (variant/modifiers) and tracks `bookingQuantities` so additive items are the only lines sent with `booking_id`; PosTenderScreen shows tip presets when charging a booking (`amount_minor` sent via `toMinorUnits`).
- **Verification**: `pos-till.integration.test.ts` (preview/charge booking, tip→commission, retail fallback, cross-branch shift 409) — 2 passing; bookings/commission suites still green; backend + FE `tsc --noEmit` clean; FE lint clean on touched files.

_Remaining: new-till manual smoke test (Store → Bookings → till), then Modules 13–16._
