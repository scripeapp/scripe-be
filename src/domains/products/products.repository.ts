import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { CategoryInput, CategoryRow, ProductCreateInput, ProductRow, ProductUpdateInput, VariantInput, VariantRow } from "./products.types.js";

export async function listProducts(c: DatabaseContext, businessId: string, filters: { storeId?: string; status?: string; search?: string }): Promise<ProductRow[]> {
  const clauses: RawBuilder<unknown>[] = [sql`p."businessId" = ${businessId}::uuid`];
  if (filters.storeId) clauses.push(sql`p."storeId" = ${filters.storeId}::uuid`);
  if (filters.status) clauses.push(sql`p."status" = ${filters.status}`); else clauses.push(sql`p."status" <> 'archived'`);
  if (filters.search) clauses.push(sql`p."name" ilike ${`%${filters.search}%`}`);
  return (await sql<ProductRow>`select p.* from app.products p where ${sql.join(clauses, sql` and `)} order by p."createdAt" desc, p."id"`.execute(c.transaction)).rows;
}
export async function findProduct(c: DatabaseContext, businessId: string, productId: string): Promise<ProductRow | undefined> {
  return (await sql<ProductRow>`select * from app.products where "businessId"=${businessId}::uuid and "id"=${productId}::uuid limit 1`.execute(c.transaction)).rows[0];
}
/** No businessId filter — products_public_read (migration 0046) already scopes this to "active" products regardless of owner, and the caller (an order confirmation) legitimately doesn't know the business id up front. */
export async function findActiveProductsByIds(c: DatabaseContext, ids: readonly string[]): Promise<ProductRow[]> {
  if (ids.length === 0) return [];
  return (await sql<ProductRow>`select * from app.products where "id" = any(${ids}::uuid[]) and "status" = 'active'`.execute(c.transaction)).rows;
}
export async function listVariants(c: DatabaseContext, businessId: string, productId: string): Promise<VariantRow[]> {
  return (await sql<VariantRow>`select * from app.product_variants where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid and "status" <> 'archived' order by "isDefault" desc, "createdAt"`.execute(c.transaction)).rows;
}
export async function categoryIds(c: DatabaseContext, businessId: string, productId: string): Promise<string[]> {
  return (await sql<{ categoryId: string }>`select "categoryId" from app.product_categories where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid order by "createdAt"`.execute(c.transaction)).rows.map((r) => r.categoryId);
}
export async function createProduct(c: DatabaseContext, businessId: string, userId: string, input: ProductCreateInput, slugValue: string): Promise<ProductRow> {
  const p = (await sql<ProductRow>`insert into app.products ("businessId","storeId","name","slug","description","productType","status","isSellable","trackInventory","allowBackorder","createdBy") values (${businessId}::uuid,${input.storeId}::uuid,${input.name},${slugValue},${input.description ?? ''},${input.productType ?? 'physical'},${input.status ?? 'draft'},${input.isSellable ?? true},${input.trackInventory ?? false},${input.allowBackorder ?? false},${userId}::uuid) returning *`.execute(c.transaction)).rows[0]!;
  const v = input.variant ?? {};
  await sql`insert into app.product_variants ("businessId","productId","name","sku","optionValues","unitId","isDefault") values (${businessId}::uuid,${p.id}::uuid,${v.name ?? 'Default'},${v.sku ?? null},${JSON.stringify(v.optionValues ?? {})}::jsonb,${v.unitId ?? null}::uuid,true)`.execute(c.transaction);
  if (input.categoryIds?.length) await setCategories(c, businessId, p.id, input.categoryIds);
  return p;
}
export async function updateProduct(c: DatabaseContext, businessId: string, productId: string, input: ProductUpdateInput): Promise<ProductRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`); if (input.slug !== undefined) fields.push(sql`"slug"=${input.slug}`); if (input.description !== undefined) fields.push(sql`"description"=${input.description}`); if (input.productType !== undefined) fields.push(sql`"productType"=${input.productType}`); if (input.status !== undefined) fields.push(sql`"status"=${input.status}`); if (input.isSellable !== undefined) fields.push(sql`"isSellable"=${input.isSellable}`); if (input.trackInventory !== undefined) fields.push(sql`"trackInventory"=${input.trackInventory}`); if (input.allowBackorder !== undefined) fields.push(sql`"allowBackorder"=${input.allowBackorder}`);
  let row = await findProduct(c, businessId, productId); if (!row) return undefined;
  if (fields.length) row = (await sql<ProductRow>`update app.products set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "id"=${productId}::uuid returning *`.execute(c.transaction)).rows[0]!;
  if (input.categoryIds !== undefined) await setCategories(c, businessId, productId, input.categoryIds);
  return row;
}
export async function archiveProduct(c: DatabaseContext, businessId: string, productId: string): Promise<boolean> { return (await sql<{ id: string }>`update app.products set "status"='archived', "archivedAt"=now() where "businessId"=${businessId}::uuid and "id"=${productId}::uuid and "status" <> 'archived' returning "id"`.execute(c.transaction)).rows.length > 0; }
export async function addVariant(c: DatabaseContext, businessId: string, productId: string, input: VariantInput): Promise<VariantRow> { if (input.isDefault) await sql`update app.product_variants set "isDefault"=false where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid`.execute(c.transaction); return (await sql<VariantRow>`insert into app.product_variants ("businessId","productId","name","sku","optionValues","unitId","isDefault") values (${businessId}::uuid,${productId}::uuid,${input.name},${input.sku ?? null},${JSON.stringify(input.optionValues ?? {})}::jsonb,${input.unitId ?? null}::uuid,${input.isDefault ?? false}) returning *`.execute(c.transaction)).rows[0]!; }
export async function listCategories(c: DatabaseContext, businessId: string): Promise<CategoryRow[]> { return (await sql<CategoryRow>`select * from app.categories where "businessId"=${businessId}::uuid and "status" <> 'archived' order by "sortOrder","name"`.execute(c.transaction)).rows; }
export async function createCategory(c: DatabaseContext, businessId: string, input: CategoryInput, slugValue: string): Promise<CategoryRow> { return (await sql<CategoryRow>`insert into app.categories ("businessId","parentId","name","slug","description","sortOrder") values (${businessId}::uuid,${input.parentId ?? null}::uuid,${input.name},${slugValue},${input.description ?? ''},${input.sortOrder ?? 0}) returning *`.execute(c.transaction)).rows[0]!; }
export async function setCategories(c: DatabaseContext, businessId: string, productId: string, ids: string[]): Promise<void> { await sql`delete from app.product_categories where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid`.execute(c.transaction); if (ids.length) await sql`insert into app.product_categories ("businessId","productId","categoryId") select ${businessId}::uuid, ${productId}::uuid, value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) value`.execute(c.transaction); }
