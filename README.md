# surge-be

## Local Subdomain Dev

To test cookie-based auth across local subdomains, prefer `lvh.me` over `*.localhost`.

Recommended backend env:

```bash
FRONTEND_URL=http://app.lvh.me:3000
AUTH_COOKIE_DOMAIN=lvh.me
ADDITIONAL_ALLOWED_ORIGIN_REGEXES=^http://[a-zA-Z0-9-]+\\.lvh\\.me:3000$
```

Recommended local URLs:

```bash
http://api.lvh.me:8000
http://app.lvh.me:3000
http://<tenant>.lvh.me:3000
```

Why:

- `*.localhost` does not behave like a shared cookie parent domain in browsers
- auth cookies scoped to `.lvh.me` are sent consistently to sibling local subdomains
- this mirrors production more closely than `subdomain.localhost`

## Coding Guidelines

- Language: TypeScript across all source files.
- Modules: Prefer ES module imports/exports. Default exports only where an API facade makes usage clearer (e.g., aggregated service export).
- Error handling: Use try/catch in controllers and return standardized JSON via `ApiResponse`.
- Validation: Use Zod schemas for all request payloads and core domain models. Parse at boundaries (controllers) before calling services.
- Types: Avoid `any`. Create small, focused types in `src/types`. Augment Express request types in `src/types/express.d.ts` when needed.
- Supabase auth: Use `authenticateUser` and `authenticateOptional` middleware. Do not add external JWT.
- Routing adapters: Use `withSupabase` to pass the Supabase client into handlers expecting `SupabaseRequest`.
- Limits and invariants: Enforce soft limits and business rules in services (e.g., page/section counts, slug uniqueness, required-page delete guard).
- Logging: Minimal, structured logs in catch blocks; no noisy console output.
- Rate limiting: Optional and lightweight; avoid new dependencies unless necessary.

### Controllers

- Responsibility: HTTP boundary—validate input, call services, map responses via `ApiResponse`.
- Shape: One file per feature; keep functions small. Prefer class-based controllers for larger features.
- Naming: Use clear names (e.g., `WebsiteController.publish` rather than generic names).

### Services

- Responsibility: Domain/business logic, DB access via Supabase client, invariants.
- Shape: Prefer cohesive class-based services exposing a clear public API; export a single default instance when convenient.
- Mapping: Keep DB↔API mapping helpers (`dbToModel`, `modelToDb`) inside the service.

## Recommended Architecture (Classes)

While the current implementation uses named functions aggregated into a default export, for larger features we recommend class-based implementations:

- Service class (`WebsiteService`): Encapsulates methods like `initUserWebsite`, `loadWebsiteByQuery`, `saveUserWebsite`, `setWebsitePublication`, `updateWebsitePage`, `updatePageSection`. Export a singleton instance: `export default new WebsiteService();`.
- Controller class (`WebsiteController`): Methods for each route handler: `init`, `me`, `load`, `save`, `publish`, `page`, `section`. Instantiate once and bind methods where needed.

Benefits:

- Clear lifecycle and single responsibility per class.
- Easier to stub/mock in tests.
- Natural place to hold shared helpers, config, and feature flags.

## Project Structure

```
src/
	app.ts                # Express app setup, middleware, route mounts
	server.ts             # Vercel serverless entry (exports app)
	local-server.ts       # Local dev entry (app.listen)
	config/               # Third-party client configuration (supabase, plunk)
	controllers/          # Route handlers (prefer class-based for larger features)
	middleware/           # CORS, Supabase auth, etc.
	migrations/           # App-level migrations scripts
	public/               # Static assets/templates (e.g., receipt-template.html)
	routes/               # Express routers per feature
	services/             # Business/domain logic (prefer class-based services)
	types/                # Shared types, adapters (e.g., withSupabase, Zod schemas)
	utils/                # Utilities (ApiResponse, tickets, formatting helpers)
supabase/
	config.toml           # Supabase project config
	migrations/           # SQL migrations for database schema
```

## API Documentation

### Interactive Documentation (Swagger UI)

When running in development mode, interactive API documentation is available at:

- **Swagger UI**: `http://localhost:3000/api/docs`
- **OpenAPI Spec (JSON)**: `http://localhost:3000/api/docs.json`

### API Reference

For detailed API documentation, see [docs/api-reference.md](./docs/api-reference.md).

### Key API Modules

| Module   | Description                      | Base Path       |
| -------- | -------------------------------- | --------------- |
| Business | Business/organization management | `/api/business` |
| Store    | E-commerce store operations      | `/api/store`    |
| Session  | Learning sessions (halqahs)      | `/api/sessions` |
| Events   | Event management                 | `/api/events`   |
| User     | User preferences & addresses     | `/api/user`     |
| Webhook  | Payment webhooks (Paystack)      | `/api/webhook`  |

## API Response Shape

All endpoints return a consistent JSON shape via `ApiResponse`:

- Success: `{ success: true, message, data }`
- Error: `{ success: false, error, message? }`

## Validation (Zod)

- Define domain schemas in `src/types` (e.g., `src/types/website.ts`).
- In controllers, validate `req.body` or `req.query` using `.parse(...)` before invoking services.
- Keep validation errors user-friendly; return `400 Bad Request` with a clear message.

## Testing

### Test Commands

```bash
# Run all tests
yarn test

# Run tests in watch mode
yarn test:watch

# Run tests with coverage report
yarn test:coverage
```

### Test Structure

Tests are located in `src/__tests__/`:

| File                         | Description                        |
| ---------------------------- | ---------------------------------- |
| `webhook.controller.test.ts` | Webhook controller unit tests      |
| `business.service.test.ts`   | Business service unit tests        |
| `user.service.test.ts`       | User service unit tests            |
| `email.service.test.ts`      | Email service unit tests           |
| `store.service.test.ts`      | Store service unit tests           |
| `session.service.test.ts`    | Session service unit tests         |
| `test-utils.ts`              | Shared test utilities and fixtures |

### Test Guidelines

- Use Jest + Supertest for route/integration tests
- Mock Supabase client using `createMockSupabaseClient()` from test-utils
- Test boundaries: auth rejection, validation, invariants, error handling
- Focus on happy path and critical error cases

## Deployment

- Vercel entry: `src/server.ts` exports the Express app as default; do not call `app.listen`.
- Local dev: `npm run dev` starts `src/local-server.ts`.
- Ensure environment variables for Supabase/Postmark/Plunk are set in Vercel Project Settings.
