import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { forbiddenError, notFoundError, type AppError } from "../../shared/errors.js";
import * as repository from "./products.repository.js";
import type { Category, CategoryInput, Product, ProductCreateInput, ProductOperation, ProductRow, ProductUpdateInput, Variant, VariantInput } from "./products.types.js";

export class ProductsService {
  constructor(private readonly database: Database) {}
  async list(operation: ProductOperation, filters: { storeId?: string; status?: string; search?: string }): Promise<Product[]> { return this.run(operation, async (c) => { const rows = await repository.listProducts(c, operation.businessId, filters); return Promise.all(rows.map((r) => this.hydrate(c, r))); }); }
  async get(operation: ProductOperation, productId: string): Promise<Product> { return this.run(operation, async (c) => { const row = await repository.findProduct(c, operation.businessId, productId); if (!row) throw notFoundError("Product not found"); return this.hydrate(c, row); }); }
  async create(operation: ProductOperation, input: ProductCreateInput): Promise<Product> { return this.run(operation, async (c) => { await this.require(c, "product.create"); const created = await repository.createProduct(c, operation.businessId, operation.userId, input, input.slug ?? `${slugify(input.name)}-${randomUUID().slice(0, 8)}`); return this.hydrate(c, created); }); }
  async update(operation: ProductOperation, productId: string, input: ProductUpdateInput): Promise<Product> { return this.run(operation, async (c) => { await this.require(c, "product.update"); const row = await repository.updateProduct(c, operation.businessId, productId, input); if (!row) throw notFoundError("Product not found"); return this.hydrate(c, row); }); }
  async archive(operation: ProductOperation, productId: string): Promise<void> { return this.run(operation, async (c) => { await this.require(c, "product.archive"); if (!(await repository.archiveProduct(c, operation.businessId, productId))) throw notFoundError("Product not found"); }); }
  async addVariant(operation: ProductOperation, productId: string, input: VariantInput): Promise<Variant> { return this.run(operation, async (c) => { await this.require(c, "product.update"); if (!(await repository.findProduct(c, operation.businessId, productId))) throw notFoundError("Product not found"); return mapVariant(await repository.addVariant(c, operation.businessId, productId, input)); }); }
  async listCategories(operation: ProductOperation): Promise<Category[]> { return this.run(operation, async (c) => (await repository.listCategories(c, operation.businessId)).map(mapCategory)); }
  async createCategory(operation: ProductOperation, input: CategoryInput): Promise<Category> { return this.run(operation, async (c) => { await this.require(c, "category.manage"); return mapCategory(await repository.createCategory(c, operation.businessId, input, input.slug ?? slugify(input.name))); }); }
  private async hydrate(c: Parameters<typeof repository.findProduct>[0], row: ProductRow): Promise<Product> { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null, variants: (await repository.listVariants(c, row.businessId, row.id)).map(mapVariant), categoryIds: await repository.categoryIds(c, row.businessId, row.id) }; }
  private async require(c: Parameters<typeof repository.findProduct>[0], permission: string): Promise<void> { if (!(await repository.hasPermission(c, permission))) throw forbiddenError(`Missing permission: ${permission}`); }
  private async run<T>(operation: ProductOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work); } catch (error) { if ((error as AppError).code) throw error; if (error instanceof DatabaseError) throw error; throw normalizeDatabaseError(error); } }
}
function slugify(value: string): string { return value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "product"; }
function mapVariant(row: Awaited<ReturnType<typeof repository.listVariants>>[number]): Variant { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null }; }
function mapCategory(row: Awaited<ReturnType<typeof repository.listCategories>>[number]): Category { return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(), archivedAt: row.archivedAt?.toISOString() ?? null }; }
