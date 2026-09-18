import express, { type Express } from "express";
import { toNodeHandler } from "better-auth/node";
import { getAuth } from "./auth/server.js";
import { cors, createCorsOptions } from "./middleware/cors.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { initializeAuthContext } from "./middleware/auth.js";
import { attachPrincipal } from "./middleware/principal.js";
import { attachRequestId } from "./middleware/request-id.js";
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

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
