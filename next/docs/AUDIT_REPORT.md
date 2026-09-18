# Implementation Review — `surge-be/next`

**Reviewed:** 2026-09-18  
**Scope:** backend foundation, PostgreSQL migrations/RLS foundation, and Better Auth  
**Repository state:** `next/` and `.github/` are still untracked in Git

## Outcome

The foundation and implemented auth flows are healthy after the fixes in this review. The backend now has a real Node.js 22 production build, the complete migration chain is reversible, guarded reset only touches application-owned schemas, auth routes receive CORS headers, infrastructure failures are no longer disguised as unauthenticated requests, and the local PostgreSQL integration suite passes.

This is not a statement that the complete authentication scope is finished. Google OAuth, passkeys, rate-limit behavior, and broader RLS negative cases still need integration/E2E coverage before auth can be called complete.

## Confirmed fixes

### Production execution

- Replaced the broken `node src/server.ts` start path with `tsc -p tsconfig.build.json` followed by `node dist/server.js`.
- Replaced runtime TypeScript path aliases with Node-resolvable relative ESM imports.
- Added startup listen-error handling and graceful `SIGTERM`/`SIGINT` shutdown of both HTTP and database resources.
- Added the production build to CI.

### Authentication and HTTP behavior

- Applied CORS before the Better Auth handler while preserving Better Auth's ownership of auth request bodies.
- Added safe support for configured `http://host:*` loopback origins, matching the existing integration-test configuration.
- Untrusted CORS origins now produce a structured 403 instead of an internal 500.
- `optionalAuth` and `requireAuth` now forward session-resolution failures to the error pipeline instead of converting database/auth infrastructure failures into false anonymous/401 responses.
- `requireAuth` now uses the common `AUTH_REQUIRED` error contract.

### Database and migrations

- Added the missing `auth.account` drop to migration `0002`'s rollback.
- Added `db:migrate:down:all`; CI now verifies the complete rollback to zero before reapplying every migration.
- Guarded `db:reset` behind `ALLOW_DATABASE_RESET=true` and disabled it unconditionally in production.
- Limited reset to `app`, `auth`, and Kysely's migration metadata. It no longer enumerates and drops unrelated database schemas.
- Moved cluster login-role ownership completely into `bootstrap.sql`; schema rollback no longer deletes runtime roles.
- Removed `CREATEDB` and `CREATEROLE` from the migrator and explicitly retained `NOSUPERUSER`/`NOBYPASSRLS` on all application roles.
- Removed broad automatic auth/app access for `surge_worker` and automatic table access for `surge_readonly`. Future worker/reporting access must be granted explicitly by the migration that needs it.
- Removed the unused `pgcrypto` extension.
- Removed the misleading `getDatabaseTransaction()` function, which returned the root database rather than a transaction.

### Dependencies, configuration, and errors

- Aligned and pinned `better-auth` and `@better-auth/passkey` to `1.7.5`.
- Aligned the direct Kysely dependency with Better Auth at `0.29.6` and updated migration imports for Kysely's current API.
- Corrected Express 4 typings to `@types/express@^4`.
- Updated `.env.example` with a valid minimum-length auth-secret example, frontend trusted origin, and the reset guard.
- Database constraint errors now map to 409/400 where appropriate; availability/retry failures remain 503.
- Unexpected database messages are no longer returned verbatim to clients.
- Corrected the `connection-unavailable` database error kind typo.
- Corrected Jest resolution for relative NodeNext `.js` imports and removed obsolete `ts-jest` configuration.
- Corrected CI Supabase scans so they inspect active `next/` implementation/config files instead of legacy paths and planning documents.

## Verification performed

| Check | Result |
| --- | --- |
| `bun install --frozen-lockfile` | Passed; no lockfile changes |
| `bun run type-check` | Passed |
| `bun run lint` | Passed |
| `bun run build` | Passed |
| Import compiled `dist/app.js` with Node | Passed |
| Guarded `bun run db:reset` | Applied migrations 0001–0004 from empty application schemas |
| `bun run db:migrate:down:all` | Reverted 0004 → 0001 successfully |
| Migration status at zero | All four reported `Not executed` |
| Reapply all migrations | Applied 0001–0004 successfully |
| `bun run db:check` | Runtime `surge_app` is not superuser, has no `BYPASSRLS`, and is not `postgres` |
| `bun run test -- --runInBand` | 15/15 tests passed across 2 suites against local PostgreSQL |
| Active-code Supabase scan | No matches |

The two Better Auth “Invalid password” warnings in the test output are expected assertions of rejected credentials.

## Current architecture notes

- Bun 1.4.2 remains the package manager and local TypeScript script runner.
- Node.js 22 remains the production runtime.
- Better Auth owns the `auth` schema; product data lives in `app`.
- `surge_app` is the API runtime identity. `surge_worker` and `surge_readonly` receive only explicitly declared access.
- RLS identity is transaction-local through `set_config(..., true)`.
- `app.user_profiles` is created/updated atomically by the hardened `SECURITY DEFINER` trigger on `auth.user`; direct application inserts have no RLS policy.

## Remaining work and risks

1. Add real integration/E2E coverage for Google OAuth and passkey registration/authentication before considering those flows complete.
2. Add explicit tests for rate limits, expired sessions/cookies, production cookie attributes, and the intended cross-subdomain deployment shape.
3. Expand RLS tests to cover anonymous, owner, other-user/tenant, and worker access—especially once the first tenant-owned domain tables arrive.
4. Add repository/service-level tests that prove PostgreSQL errors are normalized before reaching the HTTP error handler when the first domain repositories are implemented.
5. Add slow-query observability without logging SQL parameters or secrets.
6. Commit `next/`, `.github/`, and `bun.lock` before relying on frozen-lockfile and generated-file drift checks in CI.

The trigger-based profile creation remains a deliberate design choice. It is safe in the current implementation, but should remain documented because it creates an implicit side effect when Better Auth inserts or updates a user.
