import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { AddressesController } from "./addresses.controller.js";
import { AddressesService } from "./addresses.service.js";

export function createAddressesRouter(): Router {
  const router = Router();
  const controller = new AddressesController(new AddressesService(getDatabase()));
  const base = "/api/me/addresses";

  router.use(base, requireAuth);
  router.get(base, controller.list);
  router.post(base, controller.create);
  router.patch(`${base}/:addressId`, controller.update);
  router.delete(`${base}/:addressId`, controller.remove);

  return router;
}
