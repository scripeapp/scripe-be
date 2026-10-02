import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { clientIp, rateLimit } from "../../middleware/rate-limit.js";
import { PaylinksController } from "./paylinks.controller.js";
import { PaylinksService } from "./paylinks.service.js";

export function createPaylinksRouter(): Router {
  const router = Router();
  const controller = new PaylinksController(new PaylinksService(getDatabase()));

  // Public unauthenticated routes for viewing and paying through links.
  // Limits are per client IP, plus per link on checkout so one link cannot
  // be used for card testing from many IPs.
  const slugKey = (request: { params: Record<string, string> }) => request.params.slug?.toLowerCase() ?? null;
  router.get("/api/public/paylinks/checkout/:reference", rateLimit({ name: "paylink-status-ip", windowSeconds: 60, max: 60, key: clientIp }), controller.getCheckoutStatus);
  router.get("/api/public/paylinks/:slug", rateLimit({ name: "paylink-view-ip", windowSeconds: 60, max: 120, key: clientIp }), controller.getPublic);
  router.post(
    "/api/public/paylinks/:slug/checkout",
    rateLimit(
      { name: "paylink-checkout-ip", windowSeconds: 60, max: 10, key: clientIp },
      { name: "paylink-checkout-link", windowSeconds: 60, max: 30, key: slugKey },
    ),
    controller.checkoutPublic,
  );

  // Authenticated business-scoped routes
  const base = "/api/businesses/:businessId/paylinks";
  router.use(base, requireAuth);

  router.get(base, controller.list);
  router.post(base, controller.create);
  router.get(`${base}/:paylinkId`, controller.get);
  router.patch(`${base}/:paylinkId`, controller.update);
  router.delete(`${base}/:paylinkId`, controller.archive);
  router.get(`${base}/:paylinkId/payments`, controller.payments);

  return router;
}
