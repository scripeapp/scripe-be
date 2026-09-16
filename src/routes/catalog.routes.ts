import { Router } from "express";
import { authenticateUser } from "../middleware/supabase-auth-middleware";
import { requirePermission } from "../middleware/authorize.middleware";
import { validateRequest } from "../middleware/validation.middleware";
import { withSupabase } from "../types/http";
import { catalogSchemas } from "../types/catalog.schemas";
import CatalogController from "../controllers/catalog.controller";

const router = Router();

router.get(
  "/",
  authenticateUser,
  requirePermission("store.product.read"),
  validateRequest(catalogSchemas.list, "query"),
  withSupabase(CatalogController.listCatalog.bind(CatalogController)),
);

export default router;