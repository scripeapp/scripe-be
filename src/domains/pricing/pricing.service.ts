import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { randomUUID } from "node:crypto";
import { conflictError, notFoundError } from "../../shared/errors.js";
import * as inventory from "../inventory/inventory.repository.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./pricing.repository.js";
import type { LocationSetting, LocationSettingInput, Price, PriceInput, PricingOperation, ProductBranchSetting, ProductBranchSettingsInput, TaxRate } from "./pricing.types.js";
export class PricingService {
  constructor(private readonly database: Database) {}
  listPrices(o: PricingOperation, f: { productVariantId?: string; locationId?: string; assetCode?: string }): Promise<Price[]> { return this.run(o, async (c) => (await repo.listPrices(c, o.businessId, f)).map(mapPrice)); }
  createPrice(o: PricingOperation, input: PriceInput): Promise<Price> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return mapPrice(await repo.createPrice(c, o.businessId, o.userId, input)); }); }
  archivePrice(o: PricingOperation, id: string): Promise<void> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); if (!(await repo.archivePrice(c, o.businessId, id))) throw notFoundError("Price not found"); }); }
  resolve(o: PricingOperation, variantId: string, locationId: string | undefined, assetCode: string): Promise<Price> { return this.run(o, async (c) => { const price = await repo.resolvePrice(c, o.businessId, variantId, locationId, assetCode); if (!price) throw notFoundError("No active price exists for this variant and asset"); return mapPrice(price); }); }
  setLocation(o: PricingOperation, input: LocationSettingInput): Promise<LocationSetting> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return repo.upsertLocationSetting(c, o.businessId, input); }); }
  listTaxRates(o: PricingOperation): Promise<TaxRate[]> { return this.run(o, async (c) => (await repo.listTaxRates(c, o.businessId)).map(mapTax)); }
  createTaxRate(o: PricingOperation, input: Parameters<typeof repo.createTaxRate>[2]): Promise<TaxRate> { return this.run(o, async (c) => { await this.require(c, o.businessId, "pricing.manage"); return mapTax(await repo.createTaxRate(c, o.businessId, input)); }); }
  /** Every branch the product has a setting, price or stock at. Branches missing from the list use the base values. */
  getBranchSettings(o: PricingOperation, productId: string, assetCode: string): Promise<ProductBranchSetting[]> { return this.run(o, (c) => loadBranchSettings(c, o.businessId, productId, assetCode)); }
  /** Replaces the listed branches' availability, lead time and branch price, and counts stock to the given on-hand quantities, in one transaction. */
  saveBranchSettings(o: PricingOperation, productId: string, input: ProductBranchSettingsInput): Promise<ProductBranchSetting[]> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "pricing.manage");
      const variants = await repo.productVariantIds(c, o.businessId, productId);
      if (variants.length === 0) throw notFoundError("Product not found");
      const variantIds = variants.map((variant) => variant.id);
      const current = await repo.listBranchStock(c, o.businessId, variantIds);
      const stockChanges = input.branches.flatMap((branch) => Object.entries(branch.stock ?? {}).map(([variantId, quantity]) => ({ locationId: branch.locationId, variantId, quantity })));
      if (stockChanges.length > 0) await this.require(c, o.businessId, "inventory.manage");
      for (const branch of input.branches) {
        await repo.upsertLocationSetting(c, o.businessId, { productId, locationId: branch.locationId, isAvailable: branch.isAvailable, leadTimeMinutes: branch.leadTimeMinutes });
        await repo.archiveLocationPrices(c, o.businessId, variantIds, branch.locationId, input.assetCode);
        if (branch.priceMinor !== null) {
          for (const variantId of variantIds) await repo.createPrice(c, o.businessId, o.userId, { productVariantId: variantId, locationId: branch.locationId, assetCode: input.assetCode, amountMinor: branch.priceMinor });
        }
      }
      for (const change of stockChanges) {
        const variant = variants.find((candidate) => candidate.id === change.variantId);
        if (!variant) throw notFoundError("Variant not found on this product");
        const onHand = Number(current.find((row) => row.variantId === change.variantId && row.locationId === change.locationId)?.onHand ?? 0);
        const delta = change.quantity - onHand;
        if (delta === 0) continue;
        const item = await inventory.ensureItemForVariant(c, o.businessId, variant.id, variant.name, variant.sku);
        const location = await inventory.ensureLocation(c, o.businessId, change.locationId);
        try {
          await inventory.postMovement(c, o.businessId, o.userId, { inventoryItemId: item.id, inventoryLocationId: location.id, quantity: delta, type: "count", reason: "Set from the product's branch settings", idempotencyKey: randomUUID() }, o.requestId);
        } catch (error) {
          if (error instanceof Error && error.message === "Insufficient available stock") throw conflictError(`${variant.name} has more stock reserved at this branch than ${change.quantity}`);
          throw error;
        }
      }
      return loadBranchSettings(c, o.businessId, productId, input.assetCode);
    });
  }
  private async require(c: Parameters<typeof repo.listPrices>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(o: PricingOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), work); } catch (e) { if (e instanceof DatabaseError || (e && typeof e === "object" && "code" in e && "statusCode" in e)) throw e; throw normalizeDatabaseError(e); } }
}
async function loadBranchSettings(c: Parameters<typeof repo.listPrices>[0], businessId: string, productId: string, assetCode: string): Promise<ProductBranchSetting[]> {
  const variants = await repo.productVariantIds(c, businessId, productId);
  if (variants.length === 0) throw notFoundError("Product not found");
  const variantIds = variants.map((variant) => variant.id);
  const settings = await repo.listLocationSettings(c, businessId, productId);
  const prices = await repo.listLocationPrices(c, businessId, variantIds, assetCode);
  const stock = await repo.listBranchStock(c, businessId, variantIds);
  const locationIds = new Set([...settings.map((row) => row.locationId), ...prices.map((row) => row.locationId), ...stock.map((row) => row.locationId)]);
  return [...locationIds].map((locationId) => {
    const setting = settings.find((row) => row.locationId === locationId);
    // A branch price applies to every variant; report the default variant's.
    const price = prices.find((row) => row.locationId === locationId && row.productVariantId === variantIds[0]) ?? prices.find((row) => row.locationId === locationId);
    return { locationId, isAvailable: setting?.isAvailable ?? true, leadTimeMinutes: setting?.leadTimeMinutes ?? null, priceMinor: price?.amountMinor ?? null, stock: Object.fromEntries(stock.filter((row) => row.locationId === locationId).map((row) => [row.variantId, row.onHand])) };
  });
}
function mapPrice(r: Awaited<ReturnType<typeof repo.listPrices>>[number]): Price { return { ...r, effectiveFrom: r.effectiveFrom.toISOString(), effectiveTo: r.effectiveTo?.toISOString() ?? null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), archivedAt: r.archivedAt?.toISOString() ?? null }; }
function mapTax(r: Awaited<ReturnType<typeof repo.listTaxRates>>[number]): TaxRate { return r; }
