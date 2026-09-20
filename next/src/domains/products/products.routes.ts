import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";

export function createProductsRouter(): Router {
  const router = Router(); const controller = new ProductsController(new ProductsService(getDatabase())); const base = "/api/businesses/:businessId";
  router.use(base, requireAuth);
  router.get(`${base}/products`, controller.list); router.post(`${base}/products`, controller.create); router.get(`${base}/products/:productId`, controller.get); router.patch(`${base}/products/:productId`, controller.update); router.delete(`${base}/products/:productId`, controller.archive); router.post(`${base}/products/:productId/variants`, controller.addVariant);
  router.get(`${base}/categories`, controller.listCategories); router.post(`${base}/categories`, controller.createCategory);
  return router;
}
