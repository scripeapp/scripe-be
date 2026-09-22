import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { CartsController } from "./carts.controller.js";
import { CartsService } from "./carts.service.js";
export function createCartsRouter(): Router { const router = Router(); const controller = new CartsController(new CartsService(getDatabase())); const base = "/api/businesses/:businessId"; router.use(base, requireAuth); router.post(`${base}/carts`, controller.create); router.get(`${base}/carts/:cartId`, controller.get); router.post(`${base}/carts/:cartId/lines`, controller.addLine); router.patch(`${base}/carts/:cartId/lines/:lineId`, controller.updateLine); router.delete(`${base}/carts/:cartId/lines/:lineId`, controller.deleteLine); router.post(`${base}/carts/:cartId/checkout`, controller.checkout); return router; }
