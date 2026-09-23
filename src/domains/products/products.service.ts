import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { notFoundError, type AppError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import { resolvePrice } from "../pricing/pricing.repository.js";
import { ensureItemForVariant } from "../inventory/inventory.repository.js";
import * as repository from "./products.repository.js";
import type { Category, CategoryInput, CategoryUpdateInput, Product, ProductCreateInput, ProductOperation, ProductRow, ProductUpdateInput, PublicProduct, PublicVariant, Variant, VariantInput } from "./products.types.js";

export class ProductsService {
  constructor(private readonly database: Database) {}
  async list(operation: ProductOperation, filters: { storeId?: string; status?: string; search?: string }): Promise<Product[]> { return this.run(operation, async (c) => { const rows = await repository.listProducts(c, operation.businessId, filters); return Promise.all(rows.map((r) => hydrateProduct(c, r))); }); }
  async get(operation: ProductOperation, productId: string): Promise<Product> { return this.run(operation, async (c) => { const row = await repository.findProduct(c, operation.businessId, productId); if (!row) throw notFoundError("Product not found"); return hydrateProduct(c, row); }); }
  async create(operation: ProductOperation, input: ProductCreateInput): Promise<Product> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "product.create"); const created = await repository.createProduct(c, operation.businessId, operation.userId, input, input.slug ?? `${slugify(input.name)}-${randomUUID().slice(0, 8)}`); const product = await hydrateProduct(c, created); if (product.trackInventory) await Promise.all(product.variants.map((v) => ensureInventoryItem(c, operation.businessId, v))); return product; }); }
  async update(operation: ProductOperation, productId: string, input: ProductUpdateInput): Promise<Product> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "product.update"); const row = await repository.updateProduct(c, operation.businessId, productId, input); if (!row) throw notFoundError("Product not found"); const product = await hydrateProduct(c, row); if (product.trackInventory) await Promise.all(product.variants.map((v) => ensureInventoryItem(c, operation.businessId, v))); return product; }); }
  async archive(operation: ProductOperation, productId: string): Promise<void> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "product.archive"); if (!(await repository.archiveProduct(c, operation.businessId, productId))) throw notFoundError("Product not found"); }); }
  async addVariant(operation: ProductOperation, productId: string, input: VariantInput): Promise<Variant> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "product.update"); const product = await repository.findProduct(c, operation.businessId, productId); if (!product) throw notFoundError("Product not found"); const variant = mapVariant(await repository.addVariant(c, operation.businessId, productId, input)); if (product.trackInventory) await ensureInventoryItem(c, operation.businessId, variant); return variant; }); }
  async listCategories(operation: ProductOperation): Promise<Category[]> { return this.run(operation, async (c) => (await repository.listCategories(c, operation.businessId)).map(mapCategory)); }
  async createCategory(operation: ProductOperation, input: CategoryInput): Promise<Category> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "category.manage"); return mapCategory(await repository.createCategory(c, operation.businessId, input, input.slug ?? slugify(input.name))); }); }
  async updateCategory(operation: ProductOperation, categoryId: string, input: CategoryUpdateInput): Promise<Category> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "category.manage"); const row = await repository.updateCategory(c, operation.businessId, categoryId, input); if (!row) throw notFoundError("Category not found"); return mapCategory(row); }); }
  async archiveCategory(operation: ProductOperation, categoryId: string): Promise<void> { return this.run(operation, async (c) => { await this.require(c, operation.businessId, "category.manage"); if (!(await repository.archiveCategory(c, operation.businessId, categoryId))) throw notFoundError("Category not found"); }); }
  private async require(c: Parameters<typeof repository.findProduct>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(operation: ProductOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work); } catch (error) { if ((error as AppError).code) throw error; if (error instanceof DatabaseError) throw error; throw normalizeDatabaseError(error); } }
}

/**
 * Cross-domain entry points (matching accounting.postJournalEntry's
 * standalone-exported-function pattern) for the public storefront: no
 * business.userId permission check \u2014 RLS's own *_public_read policies
 * (migration 0046) are what actually restrict these to "active" rows,
 * the same way an anonymous caller is restricted everywhere else.
 */
/**
 * assetCode defaults to NGN — the overwhelming default across this schema
 * (app.businesses.defaultCurrency, every asset-scoped check constraint).
 * Multi-currency storefronts are out of scope for this browse-only pass;
 * revisit once checkout (which must get currency right regardless) exists.
 */
export async function listPublicProducts(context: DatabaseContext, businessId: string, storeId: string, assetCode = "NGN"): Promise<PublicProduct[]> {
  const rows = await repository.listProducts(context, businessId, { storeId, status: "active" });
  return Promise.all(rows.map((row) => hydratePublicProduct(context, row, assetCode)));
}

export async function listPublicCategories(context: DatabaseContext, businessId: string): Promise<Category[]> {
  return (await repository.listCategories(context, businessId)).map(mapCategory);
}

/** For order-confirmation display: batch lookup by id, not scoped to one store/business. */
export async function listPublicProductsByIds(context: DatabaseContext, ids: readonly string[], assetCode = "NGN"): Promise<PublicProduct[]> {
  const rows = await repository.findActiveProductsByIds(context, ids);
  return Promise.all(rows.map((row) => hydratePublicProduct(context, row, assetCode)));
}

async function hydrateProduct(c: DatabaseContext, row: ProductRow): Promise<Product> { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null, variants: (await repository.listVariants(c, row.businessId, row.id)).map(mapVariant), categoryIds: await repository.categoryIds(c, row.businessId, row.id) }; }

async function hydratePublicProduct(c: DatabaseContext, row: ProductRow, assetCode: string): Promise<PublicProduct> {
  const variantRows = await repository.listVariants(c, row.businessId, row.id);
  const variants: PublicVariant[] = await Promise.all(
    variantRows.map(async (variantRow) => {
      const price = await resolvePrice(c, row.businessId, variantRow.id, undefined, assetCode);
      return { ...mapVariant(variantRow), priceMinor: price?.amountMinor ?? null, compareAtMinor: price?.compareAtMinor ?? null, assetCode: price?.assetCode ?? null };
    }),
  );
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null, variants, categoryIds: await repository.categoryIds(c, row.businessId, row.id) };
}
function slugify(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "product"; }
/** A trackable product's variant always needs a matching inventory item before any stock action can touch it \u2014 see inventory.repository.ensureItemForVariant. */
function ensureInventoryItem(c: DatabaseContext, businessId: string, variant: Variant): Promise<unknown> { return ensureItemForVariant(c, businessId, variant.id, variant.name, variant.sku); }
function mapVariant(row: Awaited<ReturnType<typeof repository.listVariants>>[number]): Variant { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null }; }
function mapCategory(row: Awaited<ReturnType<typeof repository.listCategories>>[number]): Category { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null }; }
