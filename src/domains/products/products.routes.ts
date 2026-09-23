import { Router } from "express";
import { getDatabase } from "../../db/database.js";
import { requireAuth } from "../../middleware/auth.js";
import { ProductsController } from "./products.controller.js";
import { ProductsService } from "./products.service.js";

export function createProductsRouter(): Router {
  const router = Router(); const controller = new ProductsController(new ProductsService(getDatabase())); const base = "/api/businesses/:businessId";
  router.use(base, requireAuth);
  router.get(`${base}/products`, controller.list); router.post(`${base}/products`, controller.create); router.get(`${base}/products/:productId`, controller.get); router.patch(`${base}/products/:productId`, controller.update); router.delete(`${base}/products/:productId`, controller.archive); router.post(`${base}/products/:productId/variants`, controller.addVariant);
  router.get(`${base}/categories`, controller.listCategories); router.post(`${base}/categories`, controller.createCategory); router.patch(`${base}/categories/:categoryId`, controller.updateCategory); router.delete(`${base}/categories/:categoryId`, controller.archiveCategory);
  router.get(`${base}/modifier-groups`, controller.listModifierGroups); router.post(`${base}/modifier-groups`, controller.createModifierGroup); router.put(`${base}/modifier-groups/reorder`, controller.reorderModifierGroups); router.get(`${base}/modifier-groups/:groupId`, controller.getModifierGroup); router.patch(`${base}/modifier-groups/:groupId`, controller.updateModifierGroup); router.delete(`${base}/modifier-groups/:groupId`, controller.archiveModifierGroup);
  router.post(`${base}/modifier-groups/:groupId/options`, controller.createModifierOption); router.put(`${base}/modifier-groups/:groupId/options/reorder`, controller.reorderModifierOptions); router.patch(`${base}/modifier-groups/:groupId/options/:optionId`, controller.updateModifierOption); router.delete(`${base}/modifier-groups/:groupId/options/:optionId`, controller.archiveModifierOption);
  router.get(`${base}/products/:productId/modifier-groups`, controller.listProductModifierGroups); router.post(`${base}/products/:productId/modifier-groups`, controller.attachModifierGroup); router.delete(`${base}/products/:productId/modifier-groups/:groupId`, controller.detachModifierGroup);
  return router;
}
