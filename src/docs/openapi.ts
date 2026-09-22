/**
 * OpenAPI document built from the real domain Zod schemas, so the docs stay in
 * sync with request validation. This registers the auth flow plus a starter set
 * of domains (businesses, transfers, payroll); extend it by adding entries to
 * `ROUTES` and `AUTH_ROUTES` following the same pattern — reuse each domain's
 * exported `*.schemas.ts` rather than re-describing shapes here.
 *
 * Served only outside production (see routes/docs.ts).
 */
import { extendZodWithOpenApi, OpenAPIRegistry, OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import * as businesses from "../domains/businesses/businesses.schemas.js";
import * as transfers from "../domains/transfers/transfers.schemas.js";
import * as payroll from "../domains/payroll/payroll.schemas.js";

extendZodWithOpenApi(z);

const registry = new OpenAPIRegistry();

const SESSION_COOKIE = registry.registerComponent("securitySchemes", "sessionCookie", {
  type: "apiKey",
  in: "cookie",
  name: "better-auth.session_token",
  description: "Better Auth session cookie. In this same-origin Swagger UI it is set automatically after you call the sign-in (or verify-email) endpoint; no manual step needed.",
});

/** The standard success envelope every controller returns via ApiResponse. */
function ok(data: z.ZodTypeAny): z.ZodTypeAny {
  return z.object({ success: z.literal(true), data });
}
const anyData = z.record(z.any());

interface RouteDef {
  readonly method: "get" | "post" | "patch" | "delete";
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  readonly auth?: boolean;
  readonly params?: z.AnyZodObject;
  readonly query?: z.AnyZodObject;
  readonly body?: z.ZodTypeAny;
  readonly status?: 200 | 201;
}

// Better Auth owns these; described inline so the login handshake is runnable
// from Swagger. Paths are mounted before express.json(), by Better Auth itself.
const AUTH_ROUTES: RouteDef[] = [
  { method: "post", path: "/api/auth/sign-up/email", tag: "Auth", summary: "Sign up with email + password (sends an email verification OTP)", body: z.object({ email: z.string().email(), name: z.string(), password: z.string().min(8) }) },
  { method: "post", path: "/api/auth/email-otp/verify-email", tag: "Auth", summary: "Verify the email OTP (auto-signs in; sets the session cookie). In dev the code is printed to the server log as [email:dev] ... code=XXXXXX", body: z.object({ email: z.string().email(), otp: z.string() }) },
  { method: "post", path: "/api/auth/sign-in/email", tag: "Auth", summary: "Sign in with email + password (sets the session cookie)", body: z.object({ email: z.string().email(), password: z.string() }) },
  { method: "post", path: "/api/auth/sign-out", tag: "Auth", summary: "Sign out (clears the session cookie)", auth: true },
  { method: "get", path: "/api/auth/get-session", tag: "Auth", summary: "Return the current session, if any", auth: true },
];

const ROUTES: RouteDef[] = [
  // Businesses — create one first to obtain the :businessId used everywhere else.
  { method: "get", path: "/api/businesses", tag: "Businesses", summary: "List businesses the current user belongs to", auth: true },
  { method: "post", path: "/api/businesses", tag: "Businesses", summary: "Create a business (also seeds its default store and chart of accounts)", auth: true, body: businesses.createBusinessSchema, status: 201 },
  { method: "get", path: "/api/businesses/{businessId}", tag: "Businesses", summary: "Get a business", auth: true, params: businesses.businessIdParamsSchema },
  { method: "patch", path: "/api/businesses/{businessId}", tag: "Businesses", summary: "Update a business", auth: true, params: businesses.businessIdParamsSchema, body: businesses.updateBusinessSchema },

  // Transfers — beneficiaries + outbound money movement.
  { method: "get", path: "/api/businesses/{businessId}/transfers/beneficiaries", tag: "Transfers", summary: "List beneficiaries", auth: true, params: transfers.businessParamsSchema },
  { method: "post", path: "/api/businesses/{businessId}/transfers/beneficiaries", tag: "Transfers", summary: "Create (or return an existing) beneficiary", auth: true, params: transfers.businessParamsSchema, body: transfers.createBeneficiarySchema, status: 201 },
  { method: "get", path: "/api/businesses/{businessId}/transfers/beneficiaries/{beneficiaryId}", tag: "Transfers", summary: "Get a beneficiary", auth: true, params: transfers.beneficiaryParamsSchema },
  { method: "delete", path: "/api/businesses/{businessId}/transfers/beneficiaries/{beneficiaryId}", tag: "Transfers", summary: "Archive a beneficiary", auth: true, params: transfers.beneficiaryParamsSchema },
  { method: "get", path: "/api/businesses/{businessId}/transfers", tag: "Transfers", summary: "List transfers", auth: true, params: transfers.businessParamsSchema, query: transfers.listTransfersQuerySchema },
  { method: "post", path: "/api/businesses/{businessId}/transfers", tag: "Transfers", summary: "Request an outbound transfer to a beneficiary", auth: true, params: transfers.businessParamsSchema, body: transfers.requestTransferSchema, status: 201 },
  { method: "get", path: "/api/businesses/{businessId}/transfers/{transferId}", tag: "Transfers", summary: "Get a transfer with its provider attempts", auth: true, params: transfers.transferParamsSchema },

  // Payroll — runs paid via transfers.
  { method: "get", path: "/api/businesses/{businessId}/payroll/runs", tag: "Payroll", summary: "List payroll runs", auth: true, params: payroll.businessParamsSchema, query: payroll.listRunsQuerySchema },
  { method: "post", path: "/api/businesses/{businessId}/payroll/runs", tag: "Payroll", summary: "Create a draft payroll run", auth: true, params: payroll.businessParamsSchema, body: payroll.createRunSchema, status: 201 },
  { method: "get", path: "/api/businesses/{businessId}/payroll/runs/{runId}", tag: "Payroll", summary: "Get a payroll run with its items", auth: true, params: payroll.runParamsSchema },
  { method: "post", path: "/api/businesses/{businessId}/payroll/runs/{runId}/approve", tag: "Payroll", summary: "Approve a draft run", auth: true, params: payroll.runParamsSchema },
  { method: "post", path: "/api/businesses/{businessId}/payroll/runs/{runId}/pay", tag: "Payroll", summary: "Pay an approved run (executes a transfer per item, posts one journal)", auth: true, params: payroll.runParamsSchema },
  { method: "post", path: "/api/businesses/{businessId}/payroll/runs/{runId}/cancel", tag: "Payroll", summary: "Cancel a draft or approved run", auth: true, params: payroll.runParamsSchema },
];

function register(route: RouteDef): void {
  const status = route.status ?? 200;
  registry.registerPath({
    method: route.method,
    path: route.path,
    tags: [route.tag],
    summary: route.summary,
    ...(route.auth ? { security: [{ [SESSION_COOKIE.name]: [] }] } : {}),
    request: {
      ...(route.params ? { params: route.params } : {}),
      ...(route.query ? { query: route.query } : {}),
      ...(route.body ? { body: { content: { "application/json": { schema: route.body } } } } : {}),
    },
    responses: {
      [status]: { description: "Success", content: { "application/json": { schema: ok(anyData) } } },
      400: { description: "Validation error" },
      401: { description: "Authentication required" },
      403: { description: "Insufficient permission / other tenant" },
      404: { description: "Not found" },
    },
  });
}

let cached: ReturnType<OpenApiGeneratorV3["generateDocument"]> | undefined;

export function buildOpenApiDocument(): ReturnType<OpenApiGeneratorV3["generateDocument"]> {
  if (cached) return cached;
  for (const route of [...AUTH_ROUTES, ...ROUTES]) register(route);
  cached = new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: "3.0.0",
    info: {
      title: "Surge Backend API",
      version: "0.1.0",
      description: "Interactive API docs for the Surge backend. Authentication is a session cookie: call an Auth sign-in/verify endpoint first (same-origin, so the cookie is set automatically), then use the business and domain endpoints.",
    },
    servers: [{ url: "/" }],
  });
  return cached;
}
