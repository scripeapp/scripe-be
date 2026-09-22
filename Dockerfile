# syntax=docker/dockerfile:1

# Production image for a long-running host (Railway / Render / Fly.io / any
# container platform). Bun is the package manager and build tool; Node.js 22 is
# the production runtime (per the project's stack rules — a Bun runtime is a
# separate, later decision). The server is a long-lived Express process with a
# persistent pg pool, so it is run as a normal process, not a serverless
# function.

# --- Build stage: install all deps and compile TypeScript with Bun ---
FROM oven/bun:1.4.2 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build
# tsc emits JS only. The migrator reads its .sql files relative to its own
# compiled location (dist/db/migrations), so copy them into the build output.
RUN cp -r src/db/migrations dist/db/migrations

# --- Deps stage: production-only node_modules ---
FROM oven/bun:1.4.2 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# --- Runtime stage: Node.js 22 ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# The platform injects env vars (DATABASE_URL, BETTER_AUTH_SECRET, etc.) — see
# .env.example for the full contract. PORT defaults to 4000.
EXPOSE 4000

# /health/live is dependency-free; /health/ready additionally checks the DB.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run database migrations as a release/pre-deploy step, not in this CMD (see
# DEPLOY.md): node dist/db/migrate-cli.js up
CMD ["node", "dist/server.js"]
