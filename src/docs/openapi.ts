/**
 * OpenAPI document for the whole API. Every route is discovered by introspecting
 * the live Express router at request time, so the docs list stays complete and
 * in sync automatically as domains are added or changed. On top of that:
 *
 *   - Path params and HTTP methods come from the router itself.
 *   - Auth is inferred (everything needs the session cookie except /api/auth and
 *     /api/webhooks).
 *   - Tags are inferred from the path so endpoints group sensibly.
 *   - Request bodies/queries use the real domain Zod schemas where registered in
 *     REQUEST_SCHEMAS (precise, validated docs); every other POST/PATCH/PUT gets
 *     a freeform JSON body so it is still callable from "Try it out".
 *
 * To document a body precisely, add an entry to REQUEST_SCHEMAS keyed by
 * "METHOD /api/....". Reuse the domain's exported *.schemas.ts — do not re-describe
 * shapes here. Served only outside production (see routes/docs.ts).
 */
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import type { Application } from "express";
import { z } from "zod";
import * as businesses from "../domains/businesses/businesses.schemas.js";
import * as transfers from "../domains/transfers/transfers.schemas.js";
import * as payroll from "../domains/payroll/payroll.schemas.js";

extendZodWithOpenApi(z);

const COOKIE_SCHEME = "sessionCookie";
const anyData = z.record(z.any());
const freeformBody = z.record(z.any());

function ok(data: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({ success: z.literal(true), data });
}

interface Enrichment {
  readonly summary?: string;
  readonly body?: z.ZodTypeAny;
  readonly query?: z.AnyZodObject;
}

/**
 * Precise request contracts, keyed by "METHOD path" (path in :param form, as the
 * router registers it). Anything not listed is still discovered and callable with
 * a freeform JSON body. Extend this incrementally, reusing domain schemas.
 */
const REQUEST_SCHEMAS: Record<string, Enrichment> = {
  "POST /api/businesses": { body: businesses.createBusinessSchema, summary: "Create a business (seeds default store + chart of accounts)" },
  "PATCH /api/businesses/:businessId": { body: businesses.updateBusinessSchema },
  "POST /api/businesses/:businessId/transfers/beneficiaries": { body: transfers.createBeneficiarySchema, summary: "Create (or return an existing) beneficiary" },
  "POST /api/businesses/:businessId/transfers": { body: transfers.requestTransferSchema, summary: "Request an outbound transfer" },
  "GET /api/businesses/:businessId/transfers": { query: transfers.listTransfersQuerySchema },
  "POST /api/businesses/:businessId/payroll/runs": { body: payroll.createRunSchema, summary: "Create a draft payroll run" },
  "GET /api/businesses/:businessId/payroll/runs": { query: payroll.listRunsQuerySchema },
};

/** Better Auth owns these; described inline so the login handshake is runnable. */
const AUTH_ROUTES: { method: "get" | "post"; path: string; summary: string; body?: z.ZodTypeAny; auth?: boolean }[] = [
  { method: "post", path: "/api/auth/sign-up/email", summary: "Sign up with email + password (sends a verification OTP)", body: z.object({ email: z.string().email(), name: z.string(), password: z.string().min(8) }) },
  { method: "post", path: "/api/auth/email-otp/verify-email", summary: "Verify the email OTP (auto-signs in; sets the session cookie). In dev the code is printed to the server log: [email:dev] ... code=XXXXXX", body: z.object({ email: z.string().email(), otp: z.string() }) },
  { method: "post", path: "/api/auth/sign-in/email", summary: "Sign in with email + password", body: z.object({ email: z.string().email(), password: z.string() }) },
  { method: "post", path: "/api/auth/sign-out", summary: "Sign out (clears the session cookie)", auth: true },
  { method: "get", path: "/api/auth/get-session", summary: "Return the current session, if any", auth: true },
];

type Method = "get" | "post" | "put" | "patch" | "delete";

interface DiscoveredRoute {
  readonly method: Method;
  readonly path: string;
}

/** Walk the Express router stack for every registered {method, path}. */
function discoverRoutes(app: Application): DiscoveredRoute[] {
  const router = (app as unknown as { _router?: { stack: unknown[] }; router?: { stack: unknown[] } })._router ?? (app as unknown as { router?: { stack: unknown[] } }).router;
  const out: DiscoveredRoute[] = [];
  const seen = new Set<string>();
  const visit = (layer: { route?: { path: string | string[]; methods: Record<string, boolean> }; handle?: { stack?: unknown[] } }): void => {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const path of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (!["get", "post", "put", "patch", "delete"].includes(method)) continue;
          const key = `${method} ${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ method: method as Method, path });
        }
      }
    } else if (layer.handle?.stack) {
      for (const child of layer.handle.stack) visit(child as never);
    }
  };
  for (const layer of router?.stack ?? []) visit(layer as never);
  return out;
}

const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

function paramSchema(path: string): z.AnyZodObject | undefined {
  const names = [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  if (names.length === 0) return undefined;
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const name of names) shape[name] = /id$/i.test(name) ? z.string().uuid() : z.string();
  return z.object(shape);
}

function tagFor(path: string): string {
  const cap = (s: string): string => s.replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase());
  if (path.startsWith("/api/auth")) return "Auth";
  if (path.startsWith("/api/webhooks")) return "Webhooks";
  if (path.startsWith("/api/uploads")) return "Uploads";
  if (path.startsWith("/api/platform")) return "Platform";
  if (path.startsWith("/api/subscriptions")) return "Subscriptions";
  if (path.startsWith("/api/me")) return "Me";
  if (path.startsWith("/health")) return "Health";
  const scoped = path.match(/^\/api\/businesses\/:businessId\/([A-Za-z0-9_-]+)/);
  if (scoped) return cap(scoped[1]!);
  if (path.startsWith("/api/businesses")) return "Businesses";
  const seg = path.split("/").filter(Boolean)[1];
  return seg ? cap(seg) : "Other";
}

const isPublic = (path: string): boolean => path.startsWith("/api/auth") || path.startsWith("/api/webhooks");

export function buildOpenApiDocument(app: Application): ReturnType<OpenApiGeneratorV3["generateDocument"]> {
  const registry = new OpenAPIRegistry();
  registry.registerComponent("securitySchemes", COOKIE_SCHEME, {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
    description: "Better Auth session cookie. In this same-origin Swagger UI it is set automatically after you call a sign-in / verify endpoint.",
  });

  const registerOne = (method: Method, path: string, opts: { summary?: string; body?: z.ZodTypeAny; query?: z.AnyZodObject; auth: boolean; tag: string; status?: number }): void => {
    const params = paramSchema(path);
    const wantsBody = ["post", "put", "patch"].includes(method);
    const body = opts.body ?? (wantsBody ? freeformBody : undefined);
    registry.registerPath({
      method,
      path: toOpenApiPath(path),
      tags: [opts.tag],
      summary: opts.summary,
      ...(opts.auth ? { security: [{ [COOKIE_SCHEME]: [] }] } : {}),
      request: {
        ...(params ? { params } : {}),
        ...(opts.query ? { query: opts.query } : {}),
        ...(body ? { body: { content: { "application/json": { schema: body } } } } : {}),
      },
      responses: {
        [opts.status ?? (method === "post" ? 201 : 200)]: { description: "Success", content: { "application/json": { schema: ok(anyData) } } },
        400: { description: "Validation error" },
        401: { description: "Authentication required" },
        403: { description: "Insufficient permission / other tenant" },
        404: { description: "Not found" },
      },
    });
  };

  // Curated auth handshake first.
  for (const route of AUTH_ROUTES) {
    registerOne(route.method, route.path, { summary: route.summary, body: route.body, auth: route.auth ?? false, tag: "Auth", status: 200 });
  }

  // Everything the router actually exposes, minus what we curated or don't document.
  const skip = new Set(["/api/auth/*", "/openapi.json", "/docs"]);
  const authPaths = new Set(AUTH_ROUTES.map((r) => `${r.method} ${r.path}`));
  for (const { method, path } of discoverRoutes(app)) {
    if (skip.has(path) || path.startsWith("/api/auth")) continue;
    if (authPaths.has(`${method} ${path}`)) continue;
    const enrich = REQUEST_SCHEMAS[`${method.toUpperCase()} ${path}`];
    registerOne(method, path, { summary: enrich?.summary, body: enrich?.body, query: enrich?.query, auth: !isPublic(path), tag: tagFor(path) });
  }

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Scripe Backend API",
      version: "0.1.0",
      description: "Interactive API docs for the Scripe backend, generated from the live routes. Authentication is a session cookie: call an Auth sign-in/verify endpoint first (same-origin, so the cookie is set automatically), then use the business and domain endpoints. Endpoints with a precise request body are validated against the real Zod schemas; the rest accept a freeform JSON body.",
    },
    servers: [{ url: "/" }],
  });
}
