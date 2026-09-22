import type { NextFunction, Request, Response } from "express";
import { requireAuthContext } from "../../middleware/auth.js";
import { ApiResponse } from "../../shared/api-response.js";
import { businessParamsSchema, priceInputSchema, priceListSchema, priceParamsSchema, resolvePriceSchema, locationSettingSchema, taxRateSchema } from "./pricing.schemas.js";
import type { PricingService } from "./pricing.service.js";
import type { PricingOperation } from "./pricing.types.js";
export class PricingController {
  constructor(private readonly service: PricingService) {}
  readonly list = this.handle(async (r) => { const p = priceListSchema.parse(r.params); return { prices: await this.service.listPrices(this.operation(r, p.businessId), priceListSchema.omit({ businessId: true }).parse(r.query)) }; });
  readonly create = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { price: await this.service.createPrice(this.operation(r, p.businessId), priceInputSchema.parse(r.body)) }; }, 201);
  readonly archive = this.handle(async (r) => { const p = priceParamsSchema.parse(r.params); await this.service.archivePrice(this.operation(r, p.businessId), p.priceId); return { archived: true }; });
  readonly resolve = this.handle(async (r) => { const p = resolvePriceSchema.parse({ ...r.params, ...r.query }); return { price: await this.service.resolve(this.operation(r, p.businessId), p.productVariantId, p.locationId, p.assetCode) }; });
  readonly setLocation = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { setting: await this.service.setLocation(this.operation(r, p.businessId), locationSettingSchema.parse(r.body)) }; }, 201);
  readonly listTaxRates = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { taxRates: await this.service.listTaxRates(this.operation(r, p.businessId)) }; });
  readonly createTaxRate = this.handle(async (r) => { const p = businessParamsSchema.parse(r.params); return { taxRate: await this.service.createTaxRate(this.operation(r, p.businessId), taxRateSchema.parse(r.body)) }; }, 201);
  private operation(r: Request, businessId: string): PricingOperation { return { userId: requireAuthContext(r).userId, businessId, requestId: r.requestId }; }
  private handle<T>(work: (r: Request) => Promise<T>, status = 200) { return async (r: Request, res: Response, next: NextFunction): Promise<void> => { try { ApiResponse.success(res, await work(r), status); } catch (e) { next(e); } }; }
}
