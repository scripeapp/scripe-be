import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { StoresController } from "./stores.controller.js";
import { StoresService } from "./stores.service.js";

export function createStoresRouter(): Router {
  const router = Router();
  const controller = new StoresController(new StoresService(getDatabase()));
  const base = "/api/businesses/:businessId/stores";

  router.use(base, requireAuth);
  router.get(base, controller.listStores);
  router.post(base, controller.createStore);
  router.get(`${base}/:storeId`, controller.getStore);
  router.patch(`${base}/:storeId`, controller.updateStore);
  router.delete(`${base}/:storeId`, controller.archiveStore);

  router.get(`${base}/:storeId/locations`, controller.listLocations);
  router.post(`${base}/:storeId/locations`, controller.createLocation);
  router.patch(
    `${base}/:storeId/locations/:childId`,
    controller.updateLocation,
  );
  router.delete(
    `${base}/:storeId/locations/:childId`,
    controller.archiveLocation,
  );

  router.get(`${base}/:storeId/channels`, controller.listChannels);
  router.post(`${base}/:storeId/channels`, controller.createChannel);
  router.patch(`${base}/:storeId/channels/:childId`, controller.updateChannel);
  router.delete(
    `${base}/:storeId/channels/:childId`,
    controller.archiveChannel,
  );

  router.get(`${base}/:storeId/registers`, controller.listRegisters);
  router.post(`${base}/:storeId/registers`, controller.createRegister);
  router.patch(
    `${base}/:storeId/registers/:registerId`,
    controller.updateRegister,
  );
  router.delete(
    `${base}/:storeId/registers/:registerId`,
    controller.archiveRegister,
  );
  router.get(
    `${base}/:storeId/registers/:registerId/current-shift`,
    controller.getCurrentShift,
  );
  router.post(
    `${base}/:storeId/registers/:registerId/shifts`,
    controller.openShift,
  );

  router.patch(`${base}/:storeId/shifts/:shiftId/close`, controller.closeShift);
  router.get(
    `${base}/:storeId/shifts/:shiftId/cash-movements`,
    controller.listCashMovements,
  );
  router.post(
    `${base}/:storeId/shifts/:shiftId/cash-movements`,
    controller.createCashMovement,
  );

  return router;
}
