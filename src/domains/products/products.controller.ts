import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { productCreateSchema, productListParamsSchema, productParamsSchema, productUpdateSchema, categoryCreateSchema, categoryUpdateSchema, categoryParamsSchema, variantParamsSchema, variantSchema } from "./products.schemas.js";
import type { ProductsService } from "./products.service.js";
import type { ProductOperation } from "./products.types.js";

export class ProductsController {
  constructor(private readonly service: ProductsService) {}
  readonly list = this.handle(async (req) => { const p = productListParamsSchema.parse(req.params); return { products: await this.service.list(this.operation(req, p.businessId), productListParamsSchema.omit({ businessId: true }).parse(req.query)) }; });
  readonly get = this.handle(async (req) => { const p = productParamsSchema.parse(req.params); return { product: await this.service.get(this.operation(req, p.businessId), p.productId) }; });
  readonly create = this.handle(async (req) => { const p = productParamsSchema.pick({ businessId: true }).parse(req.params); return { product: await this.service.create(this.operation(req, p.businessId), productCreateSchema.parse(req.body)) }; }, 201);
  readonly update = this.handle(async (req) => { const p = productParamsSchema.parse(req.params); return { product: await this.service.update(this.operation(req, p.businessId), p.productId, productUpdateSchema.parse(req.body)) }; });
  readonly archive = this.handle(async (req) => { const p = productParamsSchema.parse(req.params); await this.service.archive(this.operation(req, p.businessId), p.productId); return { archived: true }; });
  readonly addVariant = this.handle(async (req) => { const p = variantParamsSchema.parse(req.params); return { variant: await this.service.addVariant(this.operation(req, p.businessId), p.productId, variantSchema.parse(req.body)) }; }, 201);
  readonly listCategories = this.handle(async (req) => { const p = productParamsSchema.pick({ businessId: true }).parse(req.params); return { categories: await this.service.listCategories(this.operation(req, p.businessId)) }; });
  readonly createCategory = this.handle(async (req) => { const p = productParamsSchema.pick({ businessId: true }).parse(req.params); return { category: await this.service.createCategory(this.operation(req, p.businessId), categoryCreateSchema.parse(req.body)) }; }, 201);
  readonly updateCategory = this.handle(async (req) => { const p = categoryParamsSchema.parse(req.params); return { category: await this.service.updateCategory(this.operation(req, p.businessId), p.categoryId, categoryUpdateSchema.parse(req.body)) }; });
  readonly archiveCategory = this.handle(async (req) => { const p = categoryParamsSchema.parse(req.params); await this.service.archiveCategory(this.operation(req, p.businessId), p.categoryId); return { archived: true }; });
  private operation(request: Request, businessId: string): ProductOperation { return { userId: requireAuthContext(request).userId, businessId, requestId: request.requestId }; }
  private handle<T>(work: (request: Request) => Promise<T>, statusCode = 200) { return async (request: Request, response: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(response, await work(request), statusCode); } catch (error) { next(error); } }; }
}
