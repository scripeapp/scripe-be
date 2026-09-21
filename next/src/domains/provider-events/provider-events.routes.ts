import { Router, raw } from "express";
import { getDatabase } from "../../db/database.js";
import { ProviderEventsController } from "./provider-events.controller.js";
import { ProviderEventsService } from "./provider-events.service.js";

/**
 * No requireAuth — a webhook's only caller identity is its signature,
 * verified inside the controller. Mounted with express.raw() instead of
 * the app-wide express.json() (see app.ts) because signature verification
 * needs the exact bytes the provider signed, not a re-serialized object.
 */
export function createProviderEventsRouter(): Router {
  const router = Router();
  const controller = new ProviderEventsController(new ProviderEventsService(getDatabase()));
  const base = "/api/webhooks";

  router.use(base, raw({ type: "application/json" }));
  router.post(`${base}/paystack`, controller.paystack);
  router.post(`${base}/flutterwave`, controller.flutterwave);
  router.post(`${base}/anchor`, controller.anchor);
  router.post(`${base}/brails`, controller.brails);

  return router;
}
