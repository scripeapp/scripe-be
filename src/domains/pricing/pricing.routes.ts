import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { PricingController } from "./pricing.controller.js";
import { PricingService } from "./pricing.service.js";
export function createPricingRouter(): Router { const router = Router(); const controller = new PricingController(new PricingService(getDatabase())); const base = "/api/businesses/:businessId"; router.use(base, requireAuth); router.get(`${base}/prices`, controller.list); router.post(`${base}/prices`, controller.create); router.delete(`${base}/prices/:priceId`, controller.archive); router.get(`${base}/prices/resolve`, controller.resolve); router.post(`${base}/product-location-settings`, controller.setLocation); router.get(`${base}/tax-rates`, controller.listTaxRates); router.post(`${base}/tax-rates`, controller.createTaxRate); return router; }
