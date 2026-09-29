import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PosDevicesController } from "./pos-devices.controller.js";
import { PosDevicesService } from "./pos-devices.service.js";

/**
 * Cashier devices. Merchants pair and unpair from Registers (signed in);
 * a paired device then calls /api/pos/device/* with its token header and
 * no user login.
 */
export function createPosDevicesRouter(): Router {
  const router = Router();
  const controller = new PosDevicesController(new PosDevicesService(getDatabase()));

  const registers = "/api/businesses/:businessId/stores/:storeId/registers/:registerId";
  router.post(`${registers}/pairing-code`, requireAuth, controller.createPairingCode);
  router.get(`${registers}/devices`, requireAuth, controller.listDevices);
  router.post(`${registers}/unpair`, requireAuth, controller.unpair);

  const device = "/api/pos/device";
  router.post(`${device}/pair`, controller.pair);
  router.use(device, controller.requireDevice);
  router.get(`${device}/session`, controller.session);
  router.post(`${device}/unlock`, controller.unlock);
  router.get(`${device}/catalog`, controller.catalog);
  router.get(`${device}/products/:productId`, controller.product);
  router.get(`${device}/products/:productId/modifier-groups`, controller.modifierGroups);
  router.get(`${device}/shift`, controller.currentShift);
  router.get(`${device}/shift/summary`, controller.shiftSummary);
  router.post(`${device}/shift/open`, controller.openShift);
  router.post(`${device}/shift/close`, controller.closeShift);
  router.post(`${device}/order/preview`, controller.preview);
  router.post(`${device}/order`, controller.charge);
  router.get(`${device}/orders`, controller.orders);
  router.get(`${device}/customers`, controller.customers);

  return router;
}
