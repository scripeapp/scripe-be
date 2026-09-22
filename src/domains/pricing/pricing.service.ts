import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./pricing.repository.js";
import type { LocationSetting, LocationSettingInput, Price, PriceInput, PricingOperation, TaxRate } from "./pricing.types.js";
export class PricingService {
  constructor(private readonly database: Database) {}
  listPrices(o: PricingOperation, f: { productVariantId?: string; locationId?: string; assetCode?: string }): Promise<Price[]> { return this.run(o, async (c) => (await repo.listPrices(c, o.businessId, f)).map(mapPrice)); }
  createPrice(o: PricingOperation, input: PriceInput): Promise<Price> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return mapPrice(await repo.createPrice(c, o.businessId, o.userId, input)); }); }
  archivePrice(o: PricingOperation, id: string): Promise<void> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); if (!(await repo.archivePrice(c, o.businessId, id))) throw notFoundError("Price not found"); }); }
  resolve(o: PricingOperation, variantId: string, locationId: string | undefined, assetCode: string): Promise<Price> { return this.run(o, async (c) => { const price = await repo.resolvePrice(c, o.businessId, variantId, locationId, assetCode); if (!price) throw notFoundError("No active price exists for this variant and asset"); return mapPrice(price); }); }
  setLocation(o: PricingOperation, input: LocationSettingInput): Promise<LocationSetting> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return repo.upsertLocationSetting(c, o.businessId, input); }); }
  listTaxRates(o: PricingOperation): Promise<TaxRate[]> { return this.run(o, async (c) => (await repo.listTaxRates(c, o.businessId)).map(mapTax)); }
  createTaxRate(o: PricingOperation, input: Parameters<typeof repo.createTaxRate>[2]): Promise<TaxRate> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return mapTax(await repo.createTaxRate(c, o.businessId, input)); }); }
  private async require(c: Parameters<typeof repo.listPrices>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(o: PricingOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), work); } catch (e) { if (e instanceof DatabaseError || (e && typeof e === "object" && "code" in e && "statusCode" in e)) throw e; throw normalizeDatabaseError(e); } }
}
function mapPrice(r: Awaited<ReturnType<typeof repo.listPrices>>[number]): Price { return { ...r, effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null }; }
function mapTax(r: Awaited<ReturnType<typeof repo.listTaxRates>>[number]): TaxRate { return r; }
