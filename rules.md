# Agent Rules — `scripe-be/next` Rewrite

Derived from `SUPABASE_REMOVAL_IMPLEMENTATION_PLAN.md`. This is the compact rulebook agents must follow when working on the new backend.

## A. Ground rules (always)

- Greenfield rewrite: no production data, no backward compatibility, no dual-writes, no compatibility facades.
- The new backend must contain **zero Supabase artifacts**: no package, import, env var, URL, `.from()`/`.rpc()` call, PostgREST query, bucket constant, or RLS using `auth.uid()`/`auth.jwt()`.
- Only the backend touches the database. The frontend communicates only via HTTP API + Better Auth client.
- Only standard PostgreSQL 16+. No vendor extensions without documentation and approval.
- ESM only from first commit (NodeNext-compatible TypeScript). Do not port CommonJS patterns from legacy.
- **Never import** from legacy `scripe-be/src`, its tests, or `scripe-be/supabase/`. Reuse legacy code only by reviewed copy + new tests.
- Legacy code is **requirements evidence, not truth**. If legacy sources conflict, stop and record a human-approved product decision — never guess.
- One authoritative lockfile per app: `bun.lock` (committed). Bun is the package manager/script runner; **Node.js 22 stays the production runtime** until separate Bun-runtime gates pass. Jest stays the test runner.
- No `any` at HTTP, domain, repository, integration, or event boundaries.
- Contract-first: Zod at every request/response boundary; OpenAPI generated from routes; typed frontend API client validated against it.
- Money in `numeric`/integer minor units (never float); `timestamptz` at UTC boundaries; `uuid` PKs; DB constraints (FK/unique/check/index) are the final integrity boundary.
- Changes touching money, inventory, permissions, or RLS require integration tests and an explicit concurrency/authorization review.
- Human approval gate: product scope, schema, auth policy, tenant boundaries, permissions, transactions, financial semantics, idempotency, concurrency, destructive actions.

## B. Never do

- No `SupabaseClient` facade, PostgREST emulator, legacy adapter, dual-write path, or proxy between backends.
- No replaying/repairing the 326 historical migrations. They are evidence for schema design only.
- No porting unclassified routes. Classify every legacy route **Keep / Redesign / Merge / Delete** before implementing; rebuild only approved capabilities.
- No writing to both databases or deploying both backends for production traffic.
- No `bunVersion` in Vercel config during this migration.
- No converting legacy `require()` calls or modernizing the frozen legacy tooling (deleted at cutover).
- No root monorepo/workspace for this migration.
- No fake/in-memory database for repository or RLS tests — use a disposable real PostgreSQL database.

## C. Schema and roles

- Schemas: `auth` (Better Auth-owned) and `app` (product/domain).
- Roles: `scripe_migrator` (runs migrations, owns schemas, never runtime), `scripe_app` (normal API traffic), `scripe_worker` (webhooks/background jobs, narrow grants), `scripe_readonly` (optional reporting).
- Runtime never connects as `postgres`, a schema owner, or a `BYPASSRLS` role.
- Schema-qualify all tables/functions/views/enums; safe `search_path` in every `SECURITY DEFINER`; revoke `PUBLIC` on privileged functions.

## D. Authorization and RLS

- RLS is defense-in-depth. At the start of each authorized transaction set transaction-local config (never session-level with pooled connections):

  ```sql
  select set_config('app.user_id', :user_id, true);
  select set_config('app.business_id', :business_id, true);
  select set_config('app.request_id', :request_id, true);
  ```

- Policies read via `current_setting('app.user_id', true)` / `app.business_id`.
- Public queries always get an explicit anonymous context; never inherit a prior request's identity.
- Worker/webhook jobs run as `scripe_worker` with dedicated functions/grants; never impersonate end users.
- Admin operations require application permission checks plus explicit policies or narrowly scoped privileged functions.
- Product authorization lives in the app domain (membership, store access, admin status, permissions). Authentication only proves identity.

## E. Storage

- R2 is the only object storage. Private buckets by default; backend-issued presigned URLs or backend streaming endpoints.
- Store object keys + metadata in PostgreSQL; never public provider URLs or Supabase hostnames/bucket paths.
- Validate size, MIME, extension, auth, and ownership server-side. Unpredictable object keys; never trust client paths. Digital downloads use short-lived signed URLs + entitlement checks.
- Orphan cleanup runs as the worker role.

## F. Execution order (chronological)

### 1. Guardrails first
- Inventory every Supabase occurrence (backend + frontend); categorize each (db/auth/storage/type/test/script/doc/dead).
- Classify every legacy route Keep/Redesign/Merge/Delete with human-approved rationale.
- Tag/branch the current legacy state for Git history.
- CI gates: fail on new Supabase imports/vars/URLs; fail if `next/` imports legacy source, legacy tests, or `scripe-be/supabase`.
- Freeze `scripe-be/src` except documented critical fixes.

### 2. Foundation (no product features)
- Scaffold `scripe-be/next`: own `package.json`, `bun.lock`, `tsconfig`, scripts, tests, `.env.example`.
- ESM/NodeNext; Express app with health + readiness, structured error handler, request ID, CORS.
- Bun tooling: `packageManager` field, fresh `bun install` per app, commit `bun.lock`. Add Kysely + `pg`. Scripts: `db:migrate`, `db:migrate:down`, `db:migrate:status`, `db:reset`, `db:seed`, `db:types`, `db:check`. Use `bunx`, `bun --watch`, `tsc --noEmit` authoritative.
- Local PostgreSQL via Docker Compose (health check + persistent dev volume); separate disposable test DB.
- One process-level `pg.Pool`; validate env with Zod at startup; timeouts, TLS from explicit env, graceful shutdown, slow-query logging without secrets.
- Environment contract adds: `DATABASE_URL`, `DATABASE_POOL_MAX`, `DATABASE_SSL_MODE`, `DATABASE_STATEMENT_TIMEOUT_MS`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_COOKIE_DOMAIN`, `AUTH_TRUSTED_ORIGINS` (and removes all `SUPABASE_*`).

### 3. Auth — the FIRST domain to implement
- Better Auth with PostgreSQL/Kysely adapter, `schemaName: "auth"`, UUID IDs.
- Enable email/password, email verification, password reset, Google OAuth, passkeys. Plunk for verification/reset/security emails.
- Opaque, database-backed, secure HTTP-only session cookies. No tokens in browser-readable storage.
- Mount `/api/auth/*` **before** `express.json()` (the auth handler reads the body itself).
- `req.auth` narrow typed shape: `{ userId, sessionId, email, emailVerified }`. Never introduce `req.supabase` or Supabase user types.
- `auth.user.id` is the canonical user UUID; `app.user_profiles.user_id` is a 1:1 FK to it; create the profile transactionally.
- Explicit trusted origins + cookie domain (cross-subdomain). Never disable CSRF/origin validation. Rate-limit auth endpoints.
- Authorization roles/memberships live in `app`, never in OAuth metadata or cookies.
- Frontend: one `auth-client.ts` (Better Auth React client); replace `AuthStateListener`, Supabase middleware, and all login/signup/logout/reset/passkey calls; remove hard-coded Supabase OAuth callback URLs.
- Auth tests: sign-up/verification/login/logout/refresh/revocation, invalid/expired/tampered cookies, password reset, Google OAuth flows, passkey flows, CSRF/origin/CORS/cookie-domain, rate limiting, profile creation/deletion consistency.

### 4. Baseline schema (after auth, before domain waves)
- Define the final intended entity model by domain (historical migrations = evidence only). Resolve duplicates/obsolete columns before writing.
- Ownership per table: user, business, store, platform, public, or worker-only. Explicit FK deletion behavior.
- New Kysely migrations in dependency order: extensions/schemas/roles → Better Auth schema → users/profiles/platform → businesses/memberships/permissions → stores/catalog/inventory/suppliers → CRM/communications → orders/payments/banking/financials → events/tickets/courses/scheduling → alerts/notifications/approvals/audit → views/functions/triggers/RLS/grants → seeds.
- `db:reset` must recreate the entire app from an empty database. Generate `database.types.ts` from the schema (never hand-maintain duplicated row types).

### 5. Database access architecture
- Interfaces: `Database` (root Kysely), `DatabaseTransaction`, `Principal`, `DatabaseContext`, `withDatabaseContext()`, `DatabaseError` (normalized unique/FK/check/serialization/deadlock/timeout).
- Repositories accept `DatabaseContext` (never the global pool). Controllers never execute SQL. Services own workflows + transaction boundaries. No external network calls while a transaction is open unless the workflow requires it.
- Financial/inventory mutations use transactions + locking/atomic updates. Repositories throw domain errors — never `{ data, error }` tuples.
- Never mechanically translate legacy queries: confirm the capability is retained, then specify cardinality, authz scope, ordering, null behavior, transactions, concurrency.

### 6. Domain rewrite waves (vertical slices)
Each slice: approved spec → schema → repository → service → controller/middleware/routes → Zod contract + OpenAPI → frontend queries → tests. Never edit legacy service files in place.

- **Wave A — Low-risk foundations:** addresses, preferences, helpdesk, notifications, public catalog reads, upload metadata (R2). Validates repository/RLS/pagination/error/API patterns.
- **Wave B — Identity-adjacent tenancy:** businesses, team memberships/invitations, roles/permissions, stores/branches/registers/staff access, admin auth + audit logs. Establishes the authorization foundation.
- **Wave C — Events, courses & scheduling:** events/courses/sessions/tickets/attendees/check-in/certificates; scheduling/availability.
- **Wave D — Commerce & operations:** catalog/products/variants/categories/digital products/suppliers/inventory; customers/CRM/audiences/campaigns/channels/credits; carts/orders/discounts/receipts/fulfillment/delivery.
- **Wave E — Financial & async critical paths (last):** payments + Paystack webhooks; refunds/tips/subscriptions/entitlements; banking/withdrawals/supplier payments/credits/approvals; bookkeeping/financials/MRR/dunning; schedulers/QStash/retries.

Large legacy modules decompose by cohesive responsibility (e.g. `store.service.ts` → catalog, inventory, ordering, suppliers, fulfillment, receipts, analytics).

### 7. PostgreSQL functions & atomic ops
- Elect a PostgreSQL function only for genuine atomicity, locking, set-based performance, or reusable DB enforcement. Trivial CRUD = repositories, not functions.
- Call new functions via schema-qualified SQL in Kysely; never reproduce `.rpc()`. Typed IO, explicit volatility, `SECURITY DEFINER` only when required (with safe `search_path`, validated identifiers, revoke PUBLIC, grant only the role).
- Concurrency-test: supplier payments, campaign credits, ticket counts, registration numbers, inventory reservation, message credits, campaign metrics, entitlements.

### 8. Frontend direct-access elimination (per domain + final sweep)
- Replace every browser `.from(...)`/mutation with a typed backend API function.
- Centralize credentials, CSRF, base URL, error normalization, request ID in `api-client.ts`.
- Move query logic into domain query modules; stable TanStack Query keys; explicit cache invalidation.
- Cursor pagination for high-volume collections; public pages use public endpoints with explicit projections + rate limits.
- Remove `scripe-fe/src/utils/supabase/`, `scripe-fe/src/supabase/`, `@supabase/ssr`, `@supabase/supabase-js`.

### 9. Storage completion
- Single R2 service (upload/download/delete/metadata/signed URLs). Private buckets by default. Metadata + ownership in `app.uploads` or the owning domain table (e.g. products, event images, avatars). Digital downloads: short-lived signed URLs + entitlement checks. Orphan cleanup via worker role.

### 10. Testing & gates (every slice)
- Unit (domain rules/mapping) · repository integration (real disposable Postgres) · RLS (anonymous/owner/member/insufficient-role/other-tenant/admin/worker negative tests) · API integration (auth/validation/authz/contracts) · concurrency (inventory/payments/refunds/credits/tickets/approvals/webhooks) · frontend query · E2E critical journeys.
- Static removal gate (must trip CI if present): `@supabase`, `SupabaseClient`, `req.supabase`, `supabase.auth`, `supabase.storage`, `supabase.co`, `SUPABASE_`, `NEXT_PUBLIC_SUPABASE_`, `auth.uid()`, `auth.jwt()`, `service_role`, `anon key`.
- Quality gates: frozen-lockfile installs; backend typecheck/lint/tests; frontend lint + prod build; E2E journeys; migration up/down/reset/seed from empty DB; RLS validated under runtime roles, not schema owner; secret scan shows no Supabase artifacts.

### 11. Destructive cutover (single, once all waves pass)
- Archive-tag the final legacy state; stop old environments; remove Supabase webhook destinations + OAuth redirect URLs; provision clean Postgres + roles; provision R2; configure Better Auth secrets/origins/callbacks/cookie domain.
- Cutover: recreate target DB → migrate as `scripe_migrator` → delete legacy backend files → promote `scripe-be/next` to repo root → deploy only the new backend → register new Paystack/QStash/Google callbacks → smoke test with fresh accounts → start workers/schedulers only after smoke tests pass.
- Post: revoke/delete all Supabase keys and secrets; confirm no requests reach Supabase domains; confirm no Supabase packages in any lockfile. Rollback = redeploy last-known-good + recreate disposable data (no dual-compatible schema).

### 12. Optional — Bun production runtime (post-migration, separate decision)
- Dual-runtime CI matrix (Node 22 + pinned Bun); verify Express/Better Auth/Kysely/AWS SDK/Plunk/QStash/Redis/Google/Chromium/PDF/uploads/cron/webhooks under Bun; compare cold start/latency/memory/pooling; preview deploy with Vercel Bun runtime; full suites against it; canary + immediate Node rollback; add `bunVersion` only after the canary succeeds.

## G. Definition of done (per feature and final)

One domain is complete only when: the full vertical slice works end-to-end through the new backend, its frontend Supabase inventory is zero, and schema-to-frontend tests + E2E pass.

The whole migration is done only when all of: fresh dev env boots with Postgres + two apps + first user (no Supabase credentials); `next` promoted with zero legacy dependency; every kept endpoint implemented + tested; RLS blocks cross-tenant access; R2 sole storage; transaction/idempotency tests for money/inventory/tickets/credits/approvals/webhooks; migrations recreate everything from empty DB; Supabase deleted from code, packages, lockfiles, env, CI, deployment, and browser traffic.

## H. The stack

| Layer | Choice |
| --- | --- |
| Language | TypeScript (strict, no `any`), ESM | 
| Package manager / scripts | Bun 1.x (`bunx`, `bun --watch`, committed `bun.lock`) |
| Production runtime | Node.js 22 (Bun runtime is a later, separate decision) |
| Server | Express (structured error handler, request ID, CORS) |
| Database | PostgreSQL 16+ (plain, vendor-neutral) |
| DB driver / access | `pg` (pooling) + Kysely (typed queries, transactions, migrations) |
| Local dev DB | Docker Compose Postgres + separate disposable test DB |
| Authentication | Better Auth (PostgreSQL/Kysely adapter, `auth` schema, UUID IDs) |
| Auth methods | Email/password, email verification, password reset, Google OAuth, passkeys |
| Emails | Plunk (verification, password reset, security) |
| Sessions | Opaque, DB-backed, HTTP-only secure cookies (no browser-readable tokens) |
| Authorization | Application permission checks + RLS via transaction-local `set_config()` (not `auth.uid()`/`auth.jwt()`) |
| DB roles | `scripe_migrator`, `scripe_app`, `scripe_worker`, `scripe_readonly` |
| Object storage | Cloudflare R2 (private buckets, presigned URLs) |
| Validation / contracts | Zod at every boundary; OpenAPI generated from routes; typed frontend API client |
| Frontend server state | TanStack Query |
| Test runner | Jest |
| Testing | Unit · repository integration (real Postgres) · RLS · API integration · concurrency · E2E |

## I. Proposed folder structure

### Backend — `scripe-be/next` (promoted to repo root at cutover)

```text
scripe-be/
  next/
    package.json          # ESM, packageManager field, scripts
    bun.lock              # single authoritative lockfile
    tsconfig.json         # NodeNext-compatible
    .env.example
    docker-compose.yml    # local PostgreSQL + persistent dev volume
    src/
      app.ts              # Express setup, middleware, route mounts
      server.ts           # production/serverless entry (Node 22)
      auth/
        auth.ts           # Better Auth config (PostgreSQL/Kysely adapter, auth schema)
        auth-handler.ts   # mounted BEFORE express.json()
        auth.middleware.ts# required-auth / optional-auth resolvers -> req.auth
        auth.types.ts     # RequestAuth { userId, sessionId, email, emailVerified }
        email-adapter.ts  # Plunk (verification, reset, security emails)
      db/
        database.ts       # process-level pg.Pool + root Kysely instance
        database.types.ts # generated from schema (never hand-maintained)
        errors.ts         # DatabaseError (normalized SQLSTATE mapping)
        migrate.ts        # Kysely migrations runner
        transaction.ts    # withDatabaseContext() - txn + RLS settings
        rls-context.ts    # Principal -> set_config('app.user_id', ...)
        migrations/       # Kysely SQL migrations (new history only)
        seeds/            # reference/dev seeds
      domains/
        <domain>/
          <domain>.repository.ts
          <domain>.service.ts
          <domain>.controller.ts
          <domain>.routes.ts
          <domain>.schemas.ts    # Zod request/response contracts
          <domain>.types.ts      # API/domain types (separate from DB row types)
      integrations/        # reviewed copies: Plunk, R2, QStash, Redis, Shipbubble,
                           # Paystack, Google Calendar, AI providers
      middleware/          # CORS, error, request-id, rate-limit, permission
      shared/              # pure helpers, calculations, document/QR/PDF generation
    tests/
      integration/         # repository + RLS tests on real disposable Postgres
      e2e/                 # critical user journeys
```

### Frontend — `scripe-fe` (rewritten in place, not greenfield)

```text
scripe-fe/src/
  lib/
    auth-client.ts        # Better Auth React client
    api-client.ts         # base URL, credentials, CSRF, error normalization, request ID
    query-client.ts
  queries/
    <domain>/
      api.ts
      hooks.ts            # TanStack Query hooks
      queryKeys.ts
      types.ts
```

### Structural rules

- Every `scripe-be/next` module is self-contained; nothing resolves legacy `scripe-be/src`, legacy tests, or `scripe-be/supabase`.
- Per-domain files own one responsibility (repository/service/controller/routes/schemas/types); controllers contain no SQL, repositories never import the global pool.
- Integrations are reviewed copies under `integrations/` with their own tests — never imports back into legacy code.
- API/domain types stay separate from database row types; explicit mapping functions bridge them.

## J. Domains in scope

The new backend is built around these domains, implemented as complete vertical slices. Deprecated domains (publications, posts, social, websites, forms) are **out of scope** and must not be rebuilt. Uploads (R2) is a permanent infrastructure capability and stays in scope.

### Platform foundations
- Users / profiles
- Businesses, team memberships, invitations
- Roles & permissions
- Administrator + audit logs

### Stores & operations
- Stores, branches, registers, staff access
- Catalog, products, variants, categories
- Digital products & entitlements
- Suppliers, inventory, stock movements
- Customers, CRM, audiences, campaigns, channels, messaging credits
- Carts, orders, discounts, receipts, fulfillment, delivery

### Payment & financial
- Payments + Paystack webhooks
- Refunds, tips, business subscriptions
- Banking, withdrawals, supplier payments, approval workflows
- Bills (supplier/utility bill creation & payment)
- Bookkeeping, financial reporting, MRR, dunning
- Schedulers, QStash, background jobs

### Events & scheduling
- Events, tickets, attendees, check-in, certificates
- Courses, sessions
- Scheduling & availability

### Support & platform ops
- Addresses, user preferences
- Helpdesk / support tickets
- NDPR / data-privacy requests
- Notifications, admin alerts, approvals
- Uploads (R2 presigned URL uploads, confirmation, video processing via QStash)
- R2 storage service