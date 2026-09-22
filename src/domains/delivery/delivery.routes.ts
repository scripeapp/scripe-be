import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { DeliveryController } from "./delivery.controller.js";
import { DeliveryService } from "./delivery.service.js";

export function createDeliveryRouter(): Router {
  const router = Router();
  const controller = new DeliveryController(new DeliveryService(getDatabase()));
  const base = "/api/businesses/:businessId";
  router.use(base, requireAuth);

  router.get(`${base}/delivery/methods`, controller.listMethods);
  router.post(`${base}/delivery/methods`, controller.createMethod);
  router.patch(`${base}/delivery/methods/:methodId`, controller.updateMethod);
  router.delete(`${base}/delivery/methods/:methodId`, controller.deactivateMethod);
  router.post(`${base}/delivery/methods/reorder`, controller.reorderMethods);
  router.post(`${base}/delivery/carrier-toggle`, controller.setCarrierDelivery);

  router.get(`${base}/delivery/zones`, controller.listZones);
  router.post(`${base}/delivery/zones`, controller.createZone);
  router.patch(`${base}/delivery/zones/:zoneId`, controller.updateZone);
  router.delete(`${base}/delivery/zones/:zoneId`, controller.deleteZone);
  router.get(`${base}/delivery/zones/match`, controller.matchZone);

  router.post(`${base}/delivery/rates`, controller.getRates);
  router.post(`${base}/delivery/shipments`, controller.createShipment);
  router.get(`${base}/delivery/shipments`, controller.listDeliveriesForOrder);
  router.post(`${base}/delivery/shipments/:deliveryId/refresh-tracking`, controller.refreshTracking);

  return router;
}
