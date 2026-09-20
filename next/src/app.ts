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
import { createHealthRouter } from "./routes/health.js";

export function createApp(): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(attachRequestId);

  // CORS must cover auth responses and preflight requests. Better Auth still
  // runs before the generic JSON parser because it owns its request bodies.
  app.use(cors(createCorsOptions()));
  app.all("/api/auth/*", toNodeHandler(getAuth()));

  app.use(express.json());

  app.use(attachPrincipal);
  app.use(initializeAuthContext);

  app.use(createHealthRouter());
  app.use(createProfilesRouter());
  app.use(createAddressesRouter());
  app.use(createHelpdeskRouter());
  app.use(createPreferencesRouter());
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
