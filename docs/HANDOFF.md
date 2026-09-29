# Service Bookings — Agent Handoff

You are a senior backend/full-stack engineer continuing an in-progress feature on the **Scripe**
codebase, held to Clean Code standards. Read this fully before writing code.

## Repos & environment
- Two git repos under `/Users/mac/Desktop/scripe/`: `scripe-be` (Express + Kysely + Postgres, ESM,
  Bun package manager, **Node 22 runtime**, Jest) and `scripe-fe` (Next.js).
- **Read `scripe-be/rules.md` first** — the binding rulebook. Key points: every `app` table is under
  **row-level security** via `app.has_business_permission("businessId", '<perm>')`; **Zod at every
  request/response boundary**, no `any`; money in integer minor units; `timestamptz` UTC; UUID PKs;
  **integration tests required** for any schema/permission/RLS change, run against a **real disposable
  Postgres** (never fake/in-memory).
- DB: backend reads **local `scripe_dev`** (`scripe-be/.env`
  `DATABASE_URL=postgres://scripe_app@localhost:5432/scripe_dev`). Run migrations with
  `bun src/db/migrate-cli.ts up`. Regenerate types with
  `DATABASE_MIGRATE_URL=postgres://scripe_migrator@localhost:5432/scripe_dev bun run db:types`.
  Run one test: `npx jest src/domains/<x>/<x>.integration.test.ts`.
  **Latest migration is `0059` — start new ones at `0060`.**
- Test/QA login: `abdulsalamabodunrin369@gmail.com` / `abdulsalam123` (business "Sprout Meals",
  id `28533ce1-e540-4cea-a721-f76c954bc50e`). Rate limits trip on rapid bursts and the dev server
  reloads on file save — space out manual `curl` checks.

## The task
Implement the remaining work in **`scripe-be/docs/SERVICE_BOOKINGS_DESIGN.md`** (read it in full —
decisions are agreed). Progress tracker: **`scripe-be/test-data/E2E_TEST_PROGRESS.md`** (keep it updated).

## Already done — do NOT rebuild; evolve/build on it
- Migrations `0056` (`app.bookings`), `0057` (`app.availability_profiles`, `app.event_types`),
  `0058` (`app.product_service_settings` + `modifier_options.extraDurationMinutes`),
  `0059` (`app.staff_profiles` / `staff_services` / `staff_schedules` / `schedule_exceptions`).
- Domains: `dashboard`, `bookings`, `scheduling`, `service-settings`, `staff` (the last two have
  passing integration tests; `bookings`/`scheduling`/`dashboard` were verified live).
  FE query layer `scripe-fe/src/queries/scheduling/*`.
- **Doc Phase 1, slices 1 & 2 are complete**: service settings on products, and bookable staff +
  services + weekly schedules + exceptions.

## What remains — do in this order

### 1. Finish Phase 1 — the booking engine (doc § "Booking engine"). This is next.
- Evolve `app.bookings` (migration `0060`): add `startsAt`/`endsAt` **UTC**, `locationId`, `source`
  (`dashboard|pos|online|walk_in`), `holdExpiresAt`, `manageToken`; backfill from the existing
  `bookingDate`/`startTime`/`endTime` + the store timezone; then drop the text columns. Update the
  status enum to `held|pending|confirmed|arrived|in_service|completed|cancelled|no_show`.
- Add `app.booking_items` (`bookingId`, `position`, `productId`, `variantId`, `staffId`, `startsAt`,
  `endsAt`, `modifierOptionIds[]`, `priceMinor`); move `productId`/`durationMinutes` onto items.
- **Put `app.bookings` and the new tables under RLS** (they were deliberately non-RLS in `0056`/`0057`
  — see the doc's "Existing bookings work" table; that is called-out tech debt to fix now). Handle the
  public `POST /store/bookings/reserve` via a narrowly scoped `SECURITY DEFINER` function (the pattern
  used for webhook reconciliation), not by leaving the table open.
- **Slot engine**: compute open slots on request from a staff member's `staff_schedules` minus
  `schedule_exceptions` and existing `booking_items` (with buffers), cut at
  `product_service_settings.slotIntervalMinutes`, filtered by `minNoticeMinutes`/`maxAdvanceDays`.
  "Anyone available" merges across staff. **Prevent double-booking with a Postgres exclusion constraint**
  on `(staffId, tstzrange(startsAt, endsAt))` for active statuses via `btree_gist` — not an application
  check. **Needs thorough concurrency/authorization tests** (rules.md).
- Then **replace** `event_types` → read from `product_service_settings`, and `availability_profiles` →
  per-staff `staff_schedules`; keep the reserve → confirm/decline → complete lifecycle and endpoint
  paths where they still fit so existing FE work carries over.

### 2. Phases 2–6 (each ships independently; see the doc's "Build order")
Bookings page + POS checkout; online booking + deposits (orders/`partially_paid`, holds, webhook
confirmation, `manageToken` reschedule/cancel); reminders/walk-ins/reporting; packages/payroll
commission; optional health layer.

## Other known gaps (in the tracker, outside the booking engine)
- **FE bookings screen is blocked**: `BookingsManager` / `AvailabilityView` import ~7 UI files deleted
  in a partial restore (`Scheduling/EventTypeDetailsDrawer`, `Scheduling/EventTypeForm`,
  `AvailabilityList`, `AvailabilityDetails`, `AvailabilityFormModal`, `contexts/ProUpgradeContext`,
  `components/Pro/ProFeatureGate`) plus two that must move into `Scheduling/` / `Availability/`
  subfolders. **Do not fabricate these — they must be restored from source.** Per the doc, keep the
  **Store → Bookings nav hidden until Phase 2**.
- Module audit paused at **Orders → Payments → Customers → Banking** (13–16 in the tracker) — resume if asked.

## Conventions to match (from the two slices already built)
- Domain layout: `<name>.{schemas,types,repository,service,controller,routes,integration.test}.ts`;
  router mounted in `src/app.ts`; controllers use a small `handle()` wrapper + `requireAuthContext`;
  services use `withDatabaseContext(db, withIdentity(requestId, userId, businessId), work)` +
  `authorization.requirePermission`; repositories use raw `sql` tagged templates.
- **Validate tenant ownership explicitly** when a write references another table's row by id (FKs don't
  enforce same-business) — see `staff.service.ts` `ensure…Owned`.
- Every migration has a `.down.sql`; regenerate codegen after; run the domain's Jest suite and confirm
  green; keep `tsc --noEmit` clean.

## Definition of done (per slice)
Migration applied + reversible; RLS policies + grants; Zod-validated endpoints wired in `app.ts`;
**passing integration tests** covering happy path, tenant/permission rejection, and concurrency where
money/slots are involved; codegen + `tsc` clean; tracker updated. Report scope honestly — if something
cannot be completed to this bar (e.g. missing FE files), say so rather than stubbing it.
