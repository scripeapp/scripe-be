# Agent Guidelines for surge-be

This document provides guidance for AI agents working in this codebase. Follow these conventions to maintain consistency and code quality.

## Agent Operating Rules

- Do not preserve backward compatibility.
- Choose the simplest implementation that fully meets the current requirements.
- Prefer established, well-maintained libraries over custom implementations.
- Make architectural decisions for the long term.
- Do not accept a stopgap that only works for now and is meant to be replaced later.

## Quick Reference

| Aspect       | Approach                                                    |
| ------------ | ----------------------------------------------------------- |
| Language     | TypeScript (strict, no `any`)                               |
| Architecture | Class-based controllers & services                          |
| Validation   | Zod schemas via `validateRequest` middleware at route level |
| Auth         | Supabase via `authenticateUser` / `authenticateOptional`    |
| Responses    | Always use `ApiResponse` utility                            |
| Database     | Supabase client from `req.supabase`                         |

---

## Project Structure

```
src/
├── app.ts              # Express setup, middleware, route mounts
├── server.ts           # Vercel serverless entry
├── local-server.ts     # Local dev entry (npm run dev)
├── config/             # Third-party clients (supabase, plunk)
├── controllers/        # HTTP handlers (class-based preferred)
├── middleware/         # Auth, CORS, validation middleware
├── routes/             # Express routers per feature
├── services/           # Business logic (class-based, singleton exports)
├── types/              # Zod schemas, TypeScript types, adapters
└── utils/              # ApiResponse, helpers, utilities
supabase/
├── config.toml         # Supabase project config
└── migrations/         # SQL migrations
```

---

## Core Patterns

### Controllers

Controllers handle HTTP concerns only—validation, calling services, and returning responses.

```typescript
// Example: controllers/feature.controller.ts
import { Request, Response } from "express";
import ApiResponse from "@/utils/apiResponse";
import FeatureService from "@/services/feature.service";

export class FeatureController {
  // req.body is already validated by route-level middleware
  async create(req: Request, res: Response) {
    try {
      const result = await FeatureService.create(
        req.supabase,
        req.user_id,
        req.body,
      );
      return ApiResponse.created(res, "Feature created", result);
    } catch (error: any) {
      return ApiResponse.serverError(res, error.message);
    }
  }
}

export default new FeatureController();
```

### Services

Services contain business logic and database access. Export singleton instances.

```typescript
// Example: services/feature.service.ts
import { SupabaseClient } from "@supabase/supabase-js";

class FeatureService {
  async create(supabase: SupabaseClient, userId: string, data: FeatureInput) {
    const { data: result, error } = await supabase
      .from("features")
      .insert({ ...data, user_id: userId })
      .single();

    if (error) throw new Error(error.message);
    return this.dbToModel(result);
  }

  private dbToModel(row: DbFeature): Feature {
    // Transform DB row to API model
  }
}

export default new FeatureService();
```

### Validation with Zod (Route-Level Middleware)

Validation is done at the **route level** using `validateRequest` middleware, NOT in controllers.

```typescript
// types/feature.schemas.ts
import { z } from "zod";

export const featureSchemas = {
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().optional(),
  }),
  update: z.object({
    id: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
  }),
};

export type FeatureCreateInput = z.infer<typeof featureSchemas.create>;
```

---

## API Response Format

Always use `ApiResponse` from `src/utils/apiResponse.ts`:

```typescript
// Success responses
ApiResponse.success(res, "Operation completed", data); // 200
ApiResponse.created(res, "Resource created", data); // 201

// Error responses
ApiResponse.badRequest(res, "Invalid input"); // 400
ApiResponse.unauthorized(res, "Not authenticated"); // 401
ApiResponse.forbidden(res, "Access denied"); // 403
ApiResponse.notFound(res, "Resource not found"); // 404
ApiResponse.serverError(res, "Internal error"); // 500
```

**Response shape:**

- Success: `{ success: true, message: string, data: any }`
- Error: `{ success: false, error: string }`

---

## Authentication

### Middleware Options

| Middleware              | Use Case                                                |
| ----------------------- | ------------------------------------------------------- |
| `authenticateUser`      | Protected routes requiring auth                         |
| `authenticateOptional`  | Routes with optional auth (public + logged-in variants) |
| `managerAuthMiddleware` | Routes requiring entity ownership                       |

### Accessing Auth Context

```typescript
// In controllers/handlers:
const userId = req.user_id; // Authenticated user's ID
const supabase = req.supabase; // Request-scoped Supabase client
```

### Route Setup

```typescript
// routes/feature.routes.ts
import { Router } from "express";
import { authenticateUser } from "@/middleware/supabase-auth-middleware";
import { validateRequest } from "@/middleware/validation.middleware";
import { requirePermission } from "@/middleware/authorize.middleware";
import { withSupabase } from "@/types/http";
import { featureSchemas } from "@/types/feature.schemas";
import FeatureController from "@/controllers/feature.controller";

const router = Router();

// Middleware order: auth → permission → validation → handler
router.post(
  "/",
  authenticateUser,
  requirePermission("feature.create"),
  validateRequest(featureSchemas.create, "body"),
  withSupabase(FeatureController.create.bind(FeatureController)),
);

router.get(
  "/",
  authenticateUser,
  requirePermission("feature.read"),
  validateRequest(featureSchemas.list, "query"),
  withSupabase(FeatureController.list.bind(FeatureController)),
);

router.delete(
  "/:id",
  authenticateUser,
  requirePermission("feature.delete"),
  validateRequest(featureSchemas.delete, "params"),
  withSupabase(FeatureController.delete.bind(FeatureController)),
);

export default router;
```

---

## Common Patterns

### Error Handling

```typescript
try {
  // Business logic
} catch (error: any) {
  if (error.name === "ZodError") {
    return ApiResponse.badRequest(res, error.errors[0].message);
  }
  console.error("[FeatureName] Error:", error.message);
  return ApiResponse.serverError(res, error.message);
}
```

### Database Operations

```typescript
// Always use request-scoped client
const { data, error } = await req.supabase
  .from("table_name")
  .select("*")
  .eq("user_id", req.user_id);

if (error) throw new Error(error.message);
```

### Adding New Features

1. **Schema**: Create Zod schemas in `src/types/feature.schemas.ts`
2. **Types**: Define TypeScript types in `src/types/feature.ts`
3. **Service**: Create `src/services/feature.service.ts` with business logic
4. **Controller**: Create `src/controllers/feature.controller.ts` for HTTP handling
5. **Routes**: Create `src/routes/feature.routes.ts` and mount in `app.ts`
6. **Migration**: Add SQL migration in `supabase/migrations/` if needed

---

## Commands

```bash
npm run dev        # Start local development server
npm run lint       # Run ESLint
npm run lint:fix   # Fix linting issues
npm run type-check # TypeScript type checking
```

---

## Do's and Don'ts

### ✅ Do

- Use class-based controllers and services for new features
- Validate all input with Zod at controller boundaries
- Use `ApiResponse` for all HTTP responses
- Use `req.supabase` for database operations
- Keep controllers thin—delegate to services
- Use structured error handling with try/catch
- Add types for all function parameters and returns

### ❌ Don't

- Use `any` type—create proper types instead
- Put business logic in controllers
- Use the global supabase client directly (use `req.supabase`)
- Return raw JSON responses—use `ApiResponse`
- Create external JWT implementations—use Supabase auth
- Add noisy console.log statements—use structured logging

---

## File Naming Conventions

| Type       | Pattern                 | Example                  |
| ---------- | ----------------------- | ------------------------ |
| Controller | `feature.controller.ts` | `business.controller.ts` |
| Service    | `feature.service.ts`    | `business.service.ts`    |
| Routes     | `feature.routes.ts`     | `business.routes.ts`     |
| Schemas    | `feature.schemas.ts`    | `business.schemas.ts`    |
| Types      | `feature.ts`            | `business.ts`            |
| Middleware | `feature.middleware.ts` | `admin.middleware.ts`    |

---

## Delivery Provider System (Shipbubble Aggregator)

Delivery uses **Shipbubble** as a single aggregator — one API key for all carriers (GIG, Kwik, DHL, Sendbox, etc.). No per-store carrier accounts.

### Architecture

```
src/services/delivery/
├── types.ts                          # DeliveryProvider interface + shared types
├── delivery.service.ts               # Thin facade — delegates to ShipbubbleProvider
└── providers/
    └── shipbubble.provider.ts        # Shipbubble API client (rates, labels, tracking)
```

### Config (`src/config/shipbubble.ts`)

```typescript
export const shipbubbleConfig = {
  apiKey: process.env.SHIPBUBBLE_API_KEY!,     // Hilaq's master key
  baseUrl: process.env.SHIPBUBBLE_BASE_URL || "https://api.shipbubble.com/v1",
  webhookSecret: process.env.SHIPBUBBLE_WEBHOOK_SECRET,
  sender: { name, email, phone, address },
  defaultCategoryId: "1",
  defaultPackageDimensions: { length: "10", width: "10", height: "10" },
};
```

### How It Works

1. **Customer enters city/state at checkout** → frontend fetches live carrier rates via `GET /api/store/public/:slug/delivery-rates?city=X&state=Y`
2. **Backend validates** sender + receiver addresses via Shipbubble, fetches rates, returns `DeliveryRate[]` sorted by price
3. **Customer selects a rate** → `delivery_provider: "shipbubble"`, `delivery_service_code`, `delivery_courier_id` sent in checkout payload
4. **Metadata stored** on Paystack payment — relayed to `createOrder` on payment success
5. **Auto-create label** in `StoreService.createOrder()` via `DeliveryService.createShipment()`:
   - Validates receiver address
   - Fetches rates to get `request_token`
   - Creates label with `service_code` + `courier_id`
   - Stores Shipbubble `order_id` in `store_orders.shipping_tracking_number`
6. **Webhook-driven tracking**: Shipbubble sends `POST /api/store/shipbubble-webhook` with status changes → `handleShipbubbleWebhook` maps Shipbubble statuses (`pending`, `in_transit`, `completed`, etc.) to internal statuses and updates the order

### API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/store/public/:slug/delivery-rates` | public | Get live carrier rates at checkout |
| POST | `/api/store/shipbubble-webhook` | public (HMAC) | Shipbubble tracking updates |

### Webhook Status Mapping

| Shipbubble Status | Internal Status     |
|-------------------|---------------------|
| pending           | pending             |
| confirmed         | processing          |
| picked_up         | processing          |
| in_transit        | shipped             |
| out_for_delivery  | shipped             |
| completed         | delivered           |
| cancelled         | cancelled           |

### Key Implementation Details

- **`ShippingTrackingNumber`** stores the Shipbubble `order_id` (used as lookup key for webhooks)
- **`ShippingCarrier`** stores the courier name (e.g., `"Shipbubble - GIG Logistics"`)
- **`DeliveryProvider` interface** is extensible for future aggregators, but only Shipbubble is active
- **HMAC verification**: Webhook handler verifies `x-ship-signature` header using SHA512 HMAC

---

## Key Files Reference

<skills_system priority="1">

## Available Skills

<!-- SKILLS_TABLE_START -->
<usage>
When users ask you to perform tasks, check if any of the available skills below can help complete the task more effectively. Skills provide specialized capabilities and domain knowledge.

How to use skills:

- Invoke: `npx openskills read <skill-name>` (run in your shell)
  - For multiple: `npx openskills read skill-one,skill-two`
- The skill content will load with detailed instructions on how to complete the task
- Base directory provided in output for resolving bundled resources (references/, scripts/, assets/)

Usage notes:

- Only use skills listed in <available_skills> below
- Do not invoke a skill that is already loaded in your context
- Each skill invocation is stateless
  </usage>

<available_skills>

<skill>
<name>api-connector</name>
<description>Connect to 100+ popular APIs using natural language - automatic authentication, request building, and response parsing</description>
<location>project</location>
</skill>

<skill>
<name>backend-architect</name>
<description>Backend architecture agent for API design, database schema, and microservices</description>
<location>project</location>
</skill>

<skill>
<name>changelog-generator</name>
<description>Generate beautiful CHANGELOG.md from git commits following Keep a Changelog format</description>
<location>project</location>
</skill>

<skill>
<name>cicd-pipeline-builder</name>
<description>Generate CI/CD pipelines for GitHub Actions, GitLab CI, Jenkins with best practices</description>
<location>project</location>
</skill>

<skill>
<name>code-migrator</name>
<description>Migrate legacy code to modern frameworks, languages, and patterns with automated refactoring and testing</description>
<location>project</location>
</skill>

<skill>
<name>data-engineer</name>
<description>Data engineering agent for ETL pipelines, data warehousing, and analytics</description>
<location>project</location>
</skill>

<skill>
<name>database-query</name>
<description>Natural language database queries with multi-database support, query optimization, and visual results</description>
<location>project</location>
</skill>

<skill>
<name>deployment-manager</name>
<description>Automated deployment orchestration with rollback, blue-green, and canary deployment strategies</description>
<location>project</location>
</skill>

<skill>
<name>devops-specialist</name>
<description>DevOps agent specializing in deployment, monitoring, and infrastructure automation</description>
<location>project</location>
</skill>

<skill>
<name>docker-wizard</name>
<description>Generate optimized Dockerfiles and docker-compose.yml with best practices and multi-stage builds</description>
<location>project</location>
</skill>

<skill>
<name>environment-manager</name>
<description>Manage development environments, configurations, and secrets across local, staging, and production</description>
<location>project</location>
</skill>

<skill>
<name>frontend-specialist</name>
<description>Frontend development agent for React, Vue, Next.js with modern UI/UX patterns</description>
<location>project</location>
</skill>

<skill>
<name>git-hooks-manager</name>
<description>Setup and manage git hooks for pre-commit, pre-push automation (lint, test, format)</description>
<location>project</location>
</skill>

<skill>
<name>hello-world</name>
<description>A simple example skill that demonstrates basic skill structure</description>
<location>project</location>
</skill>

<skill>
<name>k8s-generator</name>
<description>Generate production-ready Kubernetes manifests with Deployments, Services, ConfigMaps, and Ingress</description>
<location>project</location>
</skill>

<skill>
<name>performance-optimizer</name>
<description>Analyze and optimize code performance, identify bottlenecks, and suggest improvements</description>
<location>project</location>
</skill>

<skill>
<name>pr-reviewer</name>
<description>Autonomous AI-powered pull request reviewer with multi-agent analysis and comprehensive feedback</description>
<location>project</location>
</skill>

<skill>
<name>qa-engineer</name>
<description>QA specialist agent for test planning, execution, and regression analysis</description>
<location>project</location>
</skill>

<skill>
<name>readme-generator</name>
<description>Generates comprehensive README.md files for software projects by analyzing codebase structure</description>
<location>project</location>
</skill>

<skill>
<name>security-scanner</name>
<description>Comprehensive security scanner for vulnerabilities, hardcoded secrets, and OWASP Top 10 issues</description>
<location>project</location>
</skill>

<skill>
<name>tech-writer</name>
<description>Technical documentation specialist - create docs, API references, user guides for technical and non-technical audiences</description>
<location>project</location>
</skill>

<skill>
<name>unit-test-generator</name>
<description>Generates comprehensive unit tests for functions and classes in multiple languages</description>
<location>project</location>
</skill>

<skill>
<name>workflow-composer</name>
<description>Chain multiple skills together into automated workflows with conditional logic and parallel execution</description>
<location>project</location>
</skill>

</available_skills>

<!-- SKILLS_TABLE_END -->

</skills_system>
