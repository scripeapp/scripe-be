import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { OrdersController } from "./orders.controller.js";
import { OrdersService } from "./orders.service.js";
export function createOrdersRouter(): Router { const router = Router(); const controller = new OrdersController(new OrdersService(getDatabase())); const base = "/api/businesses/:businessId"; router.use(base, requireAuth); router.get(`${base}/orders`, controller.list); router.get(`${base}/orders/:orderId`, controller.get); return router; }
