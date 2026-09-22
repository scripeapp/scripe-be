import express, { type Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { getAuth } from "./auth/server.js";
import { cors, createCorsOptions } from "./middleware/cors.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { initializeAuthContext } from "./middleware/auth.js";
import { attachPrincipal } from "./middleware/principal.js";
import { attachRequestId } from "./middleware/request-id.js";
import { createProfilesRouter } from "./domains/profiles/profiles.routes.js";
import { createAddressesRouter } from "./domains/addresses/addresses.routes.js";
import { createHelpdeskRouter } from "./domains/helpdesk/helpdesk.routes.js";
import { createPreferencesRouter } from "./domains/preferences/preferences.routes.js";
import { createNotificationsRouter } from "./domains/notifications/notifications.routes.js";
import { createComplianceRouter } from "./domains/compliance/compliance.routes.js";
import { createAuditRouter } from "./domains/audit/audit.routes.js";
import { createUploadsRouter } from "./domains/uploads/uploads.routes.js";
import { createBusinessesRouter } from "./domains/businesses/businesses.routes.js";
import { createAuthorizationRouter } from "./domains/authorization/authorization.routes.js";
import { createStoresRouter } from "./domains/stores/stores.routes.js";
import { createPartiesRouter } from "./domains/parties/parties.routes.js";
import { createProductsRouter } from "./domains/products/products.routes.js";
import { createPricingRouter } from "./domains/pricing/pricing.routes.js";
import { createInventoryRouter } from "./domains/inventory/inventory.routes.js";
import { createCartsRouter } from "./domains/carts/carts.routes.js";
import { createPromotionsRouter } from "./domains/promotions/promotions.routes.js";
import { createOrdersRouter } from "./domains/orders/orders.routes.js";
import { createProcurementRouter } from "./domains/procurement/procurement.routes.js";
import { createPayablesRouter } from "./domains/payables/payables.routes.js";
import { createPaymentsRouter } from "./domains/payments/payments.routes.js";
import { createFulfillmentRouter } from "./domains/fulfillment/fulfillment.routes.js";
import { createReceiptsRouter } from "./domains/receipts/receipts.routes.js";
import { createReturnsRouter } from "./domains/returns/returns.routes.js";
import { createBankingRouter } from "./domains/banking/banking.routes.js";
import { createProviderEventsRouter } from "./domains/provider-events/provider-events.routes.js";
import { createApprovalsRouter } from "./domains/approvals/approvals.routes.js";
import { createPlatformRouter } from "./domains/platform/platform.routes.js";
import { createCommunicationsRouter } from "./domains/communications/communications.routes.js";
import { createRiskRouter } from "./domains/risk/risk.routes.js";
import { createDeliveryRouter } from "./domains/delivery/delivery.routes.js";
import { createJobsRouter } from "./domains/jobs/jobs.routes.js";
import { createSubscriptionsRouter } from "./domains/subscriptions/subscriptions.routes.js";
import { createAccountingRouter } from "./domains/accounting/accounting.routes.js";
import { createTransfersRouter } from "./domains/transfers/transfers.routes.js";
import { createPayrollRouter } from "./domains/payroll/payroll.routes.js";
import { createHealthRouter } from "./routes/health.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(attachRequestId);

  // CORS must cover auth responses and preflight requests. Better Auth still
  // runs before the generic JSON parser because it owns its request bodies.
  app.use(cors(createCorsOptions()));
  app.all("/api/auth/*", toNodeHandler(getAuth()));

  // Webhooks are unauthenticated (the provider's signature is the only
  // caller identity) and need the exact raw bytes the provider signed, so
  // they're mounted with their own raw-body parser before the app-wide
  // JSON parser — same reasoning as Better Auth above.
  app.use(createProviderEventsRouter());

  app.use(express.json());

  app.use(attachPrincipal);
  app.use(initializeAuthContext);

  app.use(createHealthRouter());
  app.use(createProfilesRouter());
  app.use(createAddressesRouter());
  app.use(createHelpdeskRouter());
  app.use(createPreferencesRouter());
  app.use(createNotificationsRouter());
  app.use(createComplianceRouter());
  app.use(createAuditRouter());
  app.use(createUploadsRouter());
  app.use(createBusinessesRouter());
  app.use(createAuthorizationRouter());
  app.use(createStoresRouter());
  app.use(createPartiesRouter());
  app.use(createProductsRouter());
  app.use(createPricingRouter());
  app.use(createInventoryRouter());
  app.use(createCartsRouter());
  app.use(createPromotionsRouter());
  app.use(createOrdersRouter());
  app.use(createProcurementRouter());
  app.use(createPayablesRouter());
  app.use(createPaymentsRouter());
  app.use(createFulfillmentRouter());
  app.use(createReceiptsRouter());
  app.use(createReturnsRouter());
  app.use(createBankingRouter());
  app.use(createApprovalsRouter());
  app.use(createPlatformRouter());
  app.use(createCommunicationsRouter());
  app.use(createRiskRouter());
  app.use(createDeliveryRouter());
  app.use(createJobsRouter());
  app.use(createSubscriptionsRouter());
  app.use(createAccountingRouter());
  app.use(createTransfersRouter());
  app.use(createPayrollRouter());

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
