import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import {
  CatalogService,
  type ProductAvailability,
  type ProductSalesChannel,
} from "../services/catalog.service";
import ApiResponse from "../utils/apiResponse";
import type { CatalogListQuery } from "../types/catalog.schemas";

export class CatalogController {
  async listCatalog(req: SupabaseRequest, res: Response): Promise<Response> {
    try {
      const query = req.query as unknown as CatalogListQuery;

      const service = new CatalogService(req.supabase!);
      const result = await service.listCatalog({
        storeId: query.store_id,
        businessId: req.businessId || (req.query.business_id as string),
        page: parseInt(query.page, 10),
        limit: parseInt(query.limit, 10),
        status: query.status,
        search: query.search,
        types: query.types,
        categoryIds: query.category_ids,
        availability: query.availability as ProductAvailability[] | undefined,
        priceMin: query.price_min,
        priceMax: query.price_max,
        createdFrom: query.created_from?.toISOString(),
        createdTo: query.created_to?.toISOString(),
        supplierIds: query.supplier_ids,
        createdByIds: query.created_by_ids,
        channels: query.channels as ProductSalesChannel[] | undefined,
      });

      return ApiResponse.success(res, "Catalog retrieved successfully", result);
    } catch (err: any) {
      console.error("[CatalogController listCatalog Error]:", err);
      return ApiResponse.serverError(res, err.message);
    }
  }
}

export default new CatalogController();
