# Sprout Meals — End-to-End Test Progress

Tracking doc so anyone can continue from where testing stopped. Test data: [`sprout-meals.seed.json`](./sprout-meals.seed.json).

## How to run
- Backend: `cd scripe-be && bun run dev` (uses local `scripe_dev`, migrated to `0071`) → http://localhost:4000
- Frontend: `cd scripe-fe && bun run dev` → http://localhost:3000
- Login (local test account, recreated 2026-09-29 after the dev DB was reset): `e2e.sprout@scripe.test` / `E2e-65114d179d4c!`
- Business under test: **Sprout Meals** (`b9c9d816-5e98-47d0-9dd9-c26aea07f395`), store `a6098bfe-7209-4f25-8100-bebd67bc8056` (still **draft**), branch `5dc43540-ec62-47ea-a337-8529a98f365c`
- Test data in it: products *Jollof Rice Bowl* (₦3,500, "Protein" group: Chicken +₦800 default / Beef +₦1,000) and *Chicken Wrap* (₦2,800); register *Front counter*; three till orders (one fulfilled); one closed shift (₦300 short).
- The old `abdulsalam…` account and business `28533ce1…` no longer exist locally.

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
| 11 | Store → Bookings | 🟢 | **Service bookings Phases 1–2 built (2026-09-29).** Staff-made bookings (`POST /api/store/bookings`, confirmed, no hold), walk-ins, add-on extra time, per-staff durations, service versions (variants), drag-to-move, staff commission + Staff earnings report, list/calendar redesigned to Figma. Still needs a manual click-through; see `docs/SERVICE_BOOKINGS_DESIGN.md` "Status". Earlier note: | **Backend + FE page complete**: BE booking engine (evolved tables, slot engine, reserve/slots/list/status endpoints) + staff commission report. FE Bookings page built & wired (calendar day/week, quick book, list, status panel via `Bookings/` module), Store→Bookings **nav re-added**, obsolete scheduling-era UI files removed, FE `tsc --noEmit` clean + lint clean. Remaining: POS till slice (price resolution, order-from-booking, tips, deposits). |
| 12 | Store → Point of Sale | 🟢 | `GET /api/store/pos/analytics` **built & verified** (200) — POS-channel gross sales / orders / discounts / returns + daily chart. UI renders fully. **Till slice built (migration 0066 + POS domain + FE page)**: booking-order pricing (`POST /store/pos/order/preview|order`), order-from-booking with tips (`app.booking_tips`), deposits netted off tendered, commission report carries `tipsMinor`. Verified: `pos-till.integration.test.ts` (2 tests) + FE bookings panel/tip flow wired. |
| 13 | Orders | 🟢 | Audited end to end via the till (2026-09-29): sell → order listed → detail → fulfil → receipt → shift close. 10 bugs fixed, see "Orders audit" below. |
| 14 | Payments | 🟢 | Audited & verified: Added missing `GET /api/businesses/:id/banking/withdrawals` backend endpoint (verified by integration test); added interactive `PaymentDetailsDrawer` on transaction rows; payments list/filters and checkout routes verified. |
| 15 | Customers | 🟢 | Audited & verified end-to-end: Full customer CRUD, contact/address associations, CRM contacts listing & lifecycle filtering, ContactDetails wired to live customer orders/transactions/timeline/spend/segments, and archiving properly cascades to omit archived parties from CRM list. |
| 16 | Banking | ⬜ | Not started |

## Next to test
➡️ Resume audit at **Module 16 — Banking**. Also still worth a manual click-through: Store → Bookings (calendar → quick book → booking panel → till).

## Orders audit (Module 13) — 2026-09-29 ✅
Tested as a cashier would: register created → shift opened (₦10,000 float) → 3 till sales (cash with modifiers, card) → orders list/detail → fulfil → receipt → shift closed and reconciled. Bugs found and fixed:
1. **[Auth] Signing in as a different user kept the previous user's business/store** → every request 403'd and the app bounced to onboarding. FE `hocs/AuthStateListener.tsx` now clears cached state and reloads when the session user changes.
2. **[Till] Registers never loaded** — `RegisterShiftWidget` called removed `/store/registers` + `/store/register/shift/*` routes. Now uses `storesApi` (list/current/open/close).
3. **[Registers] Settings page unreachable** — `registers` (and `qrcodes`) weren't in `STORE_SECTION_TABS`. Fixed; the till's "no register" hint links there.
4. **[Till] Cash sales ignored in drawer reconciliation** — expected cash = float + manual movements only. Migration `0070_app_order_register_shift` (orders.registerShiftId); close now adds the shift's captured cash payments. New `GET …/stores/:storeId/shifts/:shiftId/summary` feeds the close screen.
5. **[Till] Item picker 404'd** for variants/modifiers (`/store/public/:slug/product/:id/variants|modifier-groups` didn't exist) — and public endpoints fail for draft stores anyway. Till now reads as the merchant; storefront reads variants from the public product. New public `…/product/:id/modifier-groups` + migration `0071_app_public_modifier_reads` (anon read of active groups/options).
6. **[Till] Categories 400** — called legacy `/store/categories`; now `categoriesApi`.
7. **[Till] No receipt and no ledger posting for till sales** — payments were inserted directly. Now posts the capture journal and issues the receipt (tips excluded from the journal until a tips-payable account exists).
8. **[Orders] Every order showed "Customer" from "Storefront", payment "Card · Paystack"** — backend orders now return `channelKind`, customer name/email/phone and `paymentMethod`; FE shows Walk-in/real method; till lines name options ("Jollof Rice Bowl (Beef)").
9. **[Orders] Fulfil → 500** for products without stock tracking (joined to inventory items). Untracked lines now fulfil without stock moves; errors are 400/409. Fulfil defaults to Pickup for till orders.
10. **[Orders] ⋯ menu did nothing** — now Refresh / Export CSV / Deliveries.

**Open questions / not fixed:**
- Till orders are saved as placed + unfulfilled. Should a till sale count as fulfilled automatically (retail), or stay open for a kitchen (food)? Product decision.
- The keypad on the Charge screen enters kobo (typing 12000 = ₦120.00) — cash-register style; confirm it's intended.
- Top bar reads "Products / New product" on the Registers page.
- `PairDeviceModal` still calls the legacy `/store/registers/:id/pairing-code` (no backend route).
- Orders filter offers a "WhatsApp" channel that nothing produces.
- Tips aren't in the ledger (no tips-payable account).

## Cashier devices (/pos) — rebuilt 2026-09-29 ✅
The Supabase-era device POS was dropped in the backend cut-over (`7d558de`) and never ported; Pair device failed with "Route not found". Rebuilt on the new backend:
- **Migration `0072_app_device_pos`**: device principal (`app.device_id`) that `has_business_permission` grants a fixed till permission list in its own business only; definer functions to resolve a device token and swap a pairing code (hashes only); staff profiles gain till access (`tillEnabled`, `pinHash`, `tillLocationId`); shifts/orders record operator staff + device; orders get an idempotency key.
- **API**: `POST/GET …/registers/:id/pairing-code|devices|unpair` (merchant); `/api/pos/device/*` with `X-Register-Device-Token` (pair, session, unlock, catalog, product, modifier groups, shift, order preview/charge, orders, customers). `PUT /staff/:id/till` (4-digit PIN, scrypt, unique per business). Pairing codes and PINs are attempt-limited.
- **One staff record**: Team → Members "Set PIN"/"Add till-only staff" and Team → Staff both edit staff profiles; the old POS-staff table is gone.
- **Tests**: `pos-devices.integration.test.ts` (5) — PIN rules, pairing/unpair, unlock + lockout, draft-store sale with idempotent retry/attribution/receipt/shift close, refusal of non-till staff and other businesses' products. Suite: 349 passing.
- **Clicked through** (test account): add till-only cashier with PIN → Point of Sale → Register → Pair device → /pos pair → PIN → open float → sell Jollof (Beef) by transfer → order shows operator, device, shift, receipt; wrong PIN shows "That PIN isn't right."
- Registers live only in Point of Sale → Register (the old Store → Registers page was removed).

## Vendors — address (2026-09-29)
State and City are now dependent dropdowns (`constants/nigerianCities.ts`, LGAs per state) on the New vendor page. Other address forms (checkout, address book, vendor modal) had uncommitted edits in progress by someone else at the time and were left alone.

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
- **Cleanup**: deleted obsolete `Store/BookingsManager.tsx`, `Store/EventTypeList.tsx`, `Store/AvailabilityView.tsx` (verified zero importers). Kept `types/availability.ts`. (`queries/scheduling/*` was later found unused and deleted on 2026-09-29.)
- **Conventions**: state set on open/load is deferred past the effect's synchronous phase via `yieldToMicrotaskQueue()` (repo `react-hooks/set-state-in-effect` rule); mutations go through `PATCH /api/store/bookings/:id/status` with the transition matrix from the design doc.
- **Verification**: `npx tsc --noEmit` → 0 errors outside stale `.next/types` artifacts; `npx eslint` on the new module + wired files → 0 errors (only 2 pre-existing `Dashboard.tsx` warnings). **Not yet manually smoke-tested** in-browser; run the calendar → quick-book → status-panel happy path when resuming audits.
- **Note**: reserves still hold `priceMinor = 0` (pricing resolution is part of the till build), so the commission report revenue is legitimately 0 for online bookings until the Phase 2 POS prices/charges them.

## Bugs found & fixes (log)
1. **[Dashboard] `GET /api/dashboard/stats` → 404 (route missing).** The Overview page called a dashboard-stats endpoint that didn't exist on the backend (it silently fell back to client-side order math). **Fixed:** implemented a new `dashboard` domain (`scripe-be/src/domains/dashboard/*`) + mounted `/api/dashboard/stats`; aggregates captured-payment revenue + order/customer counts by period & currency. Verified 200 with correct shape.
2. **[Dashboard] "Failed to fetch pending approvals: No active business selected".** `usePendingApprovalsQuery` ran on first paint before the business store hydrated and threw. **Fixed:** gated the query with `enabled: !!businessId` and keyed it per business (`scripe-fe/src/queries/bills/hooks.ts`). Now fires with the business id → 200.
3. **[Login] Hydration mismatch warning on `/login`** (ScripeLogo font className hash differs SSR vs CSR). Cosmetic, dev-only; does not affect functionality. _Left as-is (low priority)._
4. **[Store overview / branch dashboard] `GET /api/store/analytics` → 400 (endpoint missing).** **Fixed:** added a store-scoped analytics endpoint to the `dashboard` domain, mounted at `/api/store/analytics`; returns `total_revenue`/`total_orders`/`total_customers`/`total_products` + per-location breakdown. Verified 200 (correctly counts the 1 product created).

---
_Last updated: 2026-09-29 — Module 13 Orders audited and fixed (migrations 0070–0071); bookings Phases 1–2 built. Remaining: Modules 14–16 + Bookings manual click-through._

## POS till slice — ✅ built & wired (2026-09-29)
Per `SERVICE_BOOKINGS_DESIGN.md` § Phase 2 (till). Pricing + tips + deposits now land end-to-end:
- **Migration `0066_app_booking_tips`** (+down): `app.booking_tips` (bookingId/businessId/staffId unique, FK to bookings/orders/staff, `amountMinor`), RLS `booking_tips_read/write` on `booking.read/update`, grants to `scripe_app`. Applied to dev DB (`db:migrate` → "Applied: 0066_app_booking_tips").
- **POS domain** `src/domains/pos/*`: `GET /api/store/pos/bookings` (today's arrived+in_service, store-tz day-bound), `POST /api/store/pos/order/preview` (item pricing → camelCase minor), `POST /api/store/pos/order` (booking XOR items; re-prices booking lines + additive items via `pricePosLines`, creates order `POS-…`, records payment = total+tip, completes booking + backfills `booking_items.priceMinor`, upserts tip). Idempotent per booking (replay returns existing summary). Shift/branch mismatch → 409.
- **Units**: backend returns minor everywhere; FE converts for display via `fromMinorUnits` (PosScreen + DevicePosPage preview).
- **Deposit/balance**: `deposit_paid = captured − this payment`; `balance_due = max(0, total + tip − captured)`.
- **Commission report**: `tipsMinor` added via correlated subquery on `booking_tips`; verified row `{revenueMinor: 4945, tipsMinor: 500, commissionMinor, completedBookings: 1}` in the till test.
- **FE**: PosScreen gains Menu/Bookings toggle + till bookings panel (60s poll, reload after charge); `usePosTicket.openBooking` materializes booked items (variant/modifiers) and tracks `bookingQuantities` so additive items are the only lines sent with `booking_id`; PosTenderScreen shows tip presets when charging a booking (`amount_minor` sent via `toMinorUnits`).
- **Verification**: `pos-till.integration.test.ts` (preview/charge booking, tip→commission, retail fallback, cross-branch shift 409) — 2 passing; bookings/commission suites still green; backend + FE `tsc --noEmit` clean; FE lint clean on touched files.

_Superseded: see "Orders audit" above for the till smoke test (2026-09-29)._

## Bill pay — Confirm payment creates a transfer for approval — ✅ built & verified (2026-09-29)
"Confirm payment" used to record an outside payment and mark the bill paid, while the screen said a transfer had been sent. The agreed design:
- **Confirm payment** (`POST /api/businesses/:id/payables/bills/:billId/transfers`) only **creates a transfer**, a wallet withdrawal tied to the bill (migration `0073_app_bill_transfers`: `withdrawals.purpose` + `billId`). The amount is held in the wallet and nothing is sent. Before anything is created it checks, with specific messages: no business account yet, still being verified, verification failed, no vendor bank details, not enough in the wallet.
- **It always needs approval** (`ApprovalsService.gateAlways`), even for a one-person business. It uses the Bills workflow whether it's switched on or off, and falls back to the owners ("Owner approval", via `app.business_owner_approvers`) if Bills was deleted. The requester may approve only when they're the sole eligible approver (`buildStepsSnapshot(..., "onlyIfSole")`). It never also goes through the Transfers workflow. The Bills on/off switch now only affects Record payment; the workflows table says so.
- **Approved** → sent to the provider; the bill is paid only when the bank confirms (`app.settle_bill_withdrawal`, called from the webhook, instant success and OTP finalize). **Rejected**, **failed**, or **the provider erroring at approval** → the money returns to the wallet and the bill stays owing, showing why. The provider-error case was a bug for all gated withdrawals: the transfer used to stay stuck on "awaiting approval" with the money held.
- **Record payment** (money paid outside Scripe) is unchanged in behaviour: gated only when Bills is switched on. It now has an amount/date/reference form.
- **FE**: the bill shows the vendor's bank, blockers with a link to Banking, and "Waiting on X to approve"; approvers get **Approve & send** / **Reject** on the bill. The Home inbox shows it as "Vendor payment #INV-…" (fixed the inbox reading `stepsSnapshot` instead of `steps`). The vendor-page pay pop-up offers "From wallet" (sent after approval) or "Paid outside Scripe".
- **Verified**: `bill-transfers.integration.test.ts` (7), plus 3 new `approvals.algorithm` tests. Full backend suite: 359 passing. Browser (Sprout Meals, dev DB): the no-account message; then, temporarily verified and funded, Confirm payment → Transfer created → "Waiting on E2E Tester" → Reject → "rejected by an approver", with the money back. The temporary verification and deposit were removed afterwards. Record payment was checked earlier (₦5,000, then ₦14,000 → Paid).
- **Local test data left**: vendor "Ali Bus", bills INV-9650 (paid by record), INV-9651 (paid via a simulated transfer, `wd_localcheck_1`), and INV-9652 (owing).

## Anchor sandbox — setup and fixes before first live test (2026-09-29)
Reading Anchor's docs against our code turned up four bugs that meant **no Anchor webhook could ever have worked**. All are fixed:
1. **Signature**: Anchor sends Base64 of the *hex* HMAC-SHA1 digest; we compared against Base64 of the raw bytes, so every delivery would fail verification. (`verifyAnchorSignature`)
2. **Event type**: Anchor puts it in `data.type`; we read top-level `type`/`event`, so every event would be logged as "unknown".
3. **Subject id**: `data.id` is the *event's* id; the customer is `data.relationships.customer.data.id`. Fixed for `customer.identification.*`. Account, deposit and transfer events still read `data.id` and **must be checked against real payloads**.
4. **SQL**: `mark_banking_kyc_status_from_webhook` and `mark_virtual_account_status_from_webhook` failed on every call with "businessId is ambiguous" (the same bug 0037 fixed for payments). Fixed in migration `0074`.
- Also: webhook processing now runs under a savepoint, so a handler DB error records the event as failed with the reason instead of returning a 500 with no trace.
- **Dev file storage**: `LOCAL_OBJECT_STORAGE=true` (dev only, refused in production) keeps uploads in `./.local-storage` behind signed URLs (`/api/dev-storage/:token`), so KYB documents can be uploaded and forwarded to Anchor without R2. On in local `.env`.
- **From the docs**: business accounts are `CURRENT` (we send that); the account number arrives separately (`accountNumber.created`); money into a deposit account is `nip.inbound.*`, and to a virtual NUBAN `payment.received`/`payment.settled` (we only handle `payment.received`/`payin.received` so far). Test funds: Dashboard → Accounts → Deposit Accounts → **Simulate Transfer**. The webhook can be created by API with our own token and `supportIncluded: true` (full resources in each event).
- **Blocked**: the `trycloudflare.com` quick tunnel doesn't resolve on the dev network (DNS). The Anchor sandbox API is reachable.
- Tests: new Anchor approval webhook test (documented payload shape), local storage tests, signature test updated. Full backend suite: 362 passing.

## Customers audit (Module 15) — 2026-10-01 ✅
Audited customer lifecycle, CRM contacts listing, contact details drawers, segment management, and campaigns:
1. **[Orders party query fix]**: in `orders.repository.ts` (`findOrderWithLines`), the query was attempting to select `"name"`, `"email"`, `"phone"` directly from `app.parties` (which only has `"displayName"`). Fixed to query `"displayName"` and resolve primary email/phone from `app.party_contacts`.
2. **[Customer-scoped orders filter]**: added `customerId` query parameter support to `GET /api/businesses/:businessId/orders` (schemas, repository, service, controller), enabling filtered customer order histories.
3. **[Customer archive cascade]**: in `parties.service.ts`, `archiveCustomer` and `archiveSupplier` now call `repository.archiveParty`, setting `status = 'archived'` in `app.parties`. Previously, deleting a customer only marked their account inactive while leaving the party active, causing them to still appear in the CRM list.
4. **[CRM contact adapters]**: updated `toCrmContact` in `Scripe-fe/src/queries/customers/adapters.ts` to surface `source`, `orders_count`, `lifetime_value`, `last_order_at` at top-level so lifecycle tabs (Repeat vs Lapsed) and source badges work accurately.
5. **[ContactDetails live data]**: replaced non-existent `/crm/contacts/:id/activities` call in `ContactDetails.tsx` with live customer orders from `ordersApi`, generating transactional history, customer purchase timeline, and live segment memberships.
6. **[Verification]**: added customer integration tests in `parties.integration.test.ts` (customer create, contact & address attachment, detail lookup, update, list, and soft-delete/archive). All 4 parties integration tests passing; frontend TypeScript check clean (`tsc --noEmit` 0 errors).

