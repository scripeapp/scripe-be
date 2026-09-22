import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { InventoryController } from "./inventory.controller.js";
import { InventoryService } from "./inventory.service.js";
export function createInventoryRouter(): Router { const router = Router(); const controller = new InventoryController(new InventoryService(getDatabase())); const base = "/api/businesses/:businessId/inventory"; router.use(base, requireAuth); router.get(`${base}/balances`, controller.balances); router.post(`${base}/items`, controller.createItem); router.post(`${base}/locations`, controller.createLocation); router.post(`${base}/movements`, controller.movement); router.post(`${base}/reservations`, controller.reserve); router.post(`${base}/reservations/:reservationId/release`, controller.release); return router; }
