import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PartiesController } from "./parties.controller.js";
import { PartiesService } from "./parties.service.js";

export function createPartiesRouter(): Router {
  const router = Router();
  const controller = new PartiesController(new PartiesService(getDatabase()));
  const base = "/api/businesses/:businessId";
  router.use(base, requireAuth);

  router.get(`${base}/parties`, controller.list);
  router.post(`${base}/parties`, controller.create);
  router.get(`${base}/parties/:partyId`, controller.get);
  router.patch(`${base}/parties/:partyId`, controller.update);
  router.delete(`${base}/parties/:partyId`, controller.archive);
  router.get(`${base}/parties/:partyId/contacts`, controller.listContacts);
  router.post(`${base}/parties/:partyId/contacts`, controller.createContact);
  router.patch(`${base}/parties/:partyId/contacts/:contactId`, controller.updateContact);
  router.delete(`${base}/parties/:partyId/contacts/:contactId`, controller.archiveContact);
  router.get(`${base}/parties/:partyId/addresses`, controller.listAddresses);
  router.post(`${base}/parties/:partyId/addresses`, controller.createAddress);
  router.patch(`${base}/parties/:partyId/addresses/:addressId`, controller.updateAddress);
  router.delete(`${base}/parties/:partyId/addresses/:addressId`, controller.archiveAddress);

  router.get(`${base}/customers`, controller.listCustomers);
  router.post(`${base}/customers`, controller.createCustomer);
  router.get(`${base}/customers/:partyId`, controller.getCustomer);
  router.patch(`${base}/customers/:partyId`, controller.updateCustomer);
  router.delete(`${base}/customers/:partyId`, controller.archiveCustomer);
  router.get(`${base}/suppliers`, controller.listSuppliers);
  router.post(`${base}/suppliers`, controller.createSupplier);
  router.get(`${base}/suppliers/:partyId`, controller.getSupplier);
  router.patch(`${base}/suppliers/:partyId`, controller.updateSupplier);
  router.delete(`${base}/suppliers/:partyId`, controller.archiveSupplier);
  return router;
}
