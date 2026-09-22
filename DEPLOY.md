# Deployment

The backend is a long-running Express server (Node.js 22) with a persistent
PostgreSQL pool, Better Auth sessions, and in-process background jobs. Deploy it
as a normal process/container on a long-running host (Railway, Render, Fly.io,
or any container platform) — not as serverless functions.

## Build & run

The `Dockerfile` is a multi-stage build (Bun builds, Node 22 runs):

```bash
docker build -t surge-backend .
docker run --env-file .env -p 4000:4000 surge-backend
```

Without Docker:

```bash
bun install --frozen-lockfile
bun run build          # tsc -> dist/
node dist/server.js    # reads process.env (PORT defaults to 4000)
```

## Environment

Set the variables in `.env.example` on the platform. Required in production:

- `DATABASE_URL` — runtime role (`surge_app`); never a superuser/owner/BYPASSRLS role
- `DATABASE_MIGRATE_URL` — migration role (`surge_migrator`); used only by the migrate step
- `BETTER_AUTH_SECRET` (>= 32 chars), `BETTER_AUTH_URL`, `AUTH_COOKIE_DOMAIN`, `AUTH_TRUSTED_ORIGINS`
- `PLUNK_API_KEY` / `PLUNK_FROM_EMAIL` (verification/reset/security emails)
- `R2_*` (object storage — set all four together)
- `FRONTEND_URL`

Provider integrations (banking, checkout gateways, SMS/WhatsApp, delivery) are
optional and stay on safe stubs until their keys are set — see `.env.example`.

## One-time database provisioning

Against a fresh PostgreSQL 16+ cluster, create the application roles/schemas
once (as a cluster admin). This is separate from the migration chain:

```bash
psql "$ADMIN_DATABASE_URL" -f src/db/bootstrap.sql
```

## Migrations (release / pre-deploy step)

Run migrations before starting/replacing the server, using the migrate role.
The compiled migrator ships in the image with its `.sql` files:

```bash
node dist/db/migrate-cli.js up       # apply pending migrations
node dist/db/migrate-cli.js status   # inspect state
```

`db:reset` and `down-all` are guarded behind `ALLOW_DATABASE_RESET=true` and are
never used against production.

## Health checks

- `GET /health/live` — process liveness, no dependencies (used by the image's HEALTHCHECK)
- `GET /health/ready` — readiness, verifies the database connection

Point the platform's health probe at `/health/ready`.

## Notes

- The frontend is not wired to this backend yet; that is a separate task.
- The legacy backend is archived at `../surge-be-legacy` (reference only).
