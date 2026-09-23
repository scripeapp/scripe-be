import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { AttachedModifierGroup, CategoryInput, CategoryRow, CategoryUpdateInput, ModifierGroupInput, ModifierGroupRow, ModifierGroupUpdateInput, ModifierOptionInput, ModifierOptionRow, ModifierOptionUpdateInput, ProductCreateInput, ProductRow, ProductUpdateInput, VariantInput, VariantRow } from "./products.types.js";

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
export async function findActiveProductByIdOrSlug(
  c: DatabaseContext,
  businessId: string,
  storeId: string,
  idOrSlug: string,
): Promise<ProductRow | undefined> {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idOrSlug);
  const result = await sql<ProductRow>`
    select * from app.products
    where "businessId"=${businessId}::uuid
      and "storeId"=${storeId}::uuid
      and "status"='active'
      and (${isUuid ? sql`"id"=${idOrSlug}::uuid or ` : sql``}"slug"=${idOrSlug})
    limit 1
  `.execute(c.transaction);
  return result.rows[0];
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
export async function findCategory(c: DatabaseContext, businessId: string, categoryId: string): Promise<CategoryRow | undefined> {
  return (await sql<CategoryRow>`select * from app.categories where "businessId"=${businessId}::uuid and "id"=${categoryId}::uuid limit 1`.execute(c.transaction)).rows[0];
}
export async function updateCategory(c: DatabaseContext, businessId: string, categoryId: string, input: CategoryUpdateInput): Promise<CategoryRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`); if (input.slug !== undefined) fields.push(sql`"slug"=${input.slug}`); if (input.parentId !== undefined) fields.push(sql`"parentId"=${input.parentId}::uuid`); if (input.description !== undefined) fields.push(sql`"description"=${input.description}`); if (input.sortOrder !== undefined) fields.push(sql`"sortOrder"=${input.sortOrder}`);
  let row = await findCategory(c, businessId, categoryId); if (!row) return undefined;
  if (fields.length) row = (await sql<CategoryRow>`update app.categories set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "id"=${categoryId}::uuid returning *`.execute(c.transaction)).rows[0]!;
  return row;
}
export async function archiveCategory(c: DatabaseContext, businessId: string, categoryId: string): Promise<boolean> { return (await sql<{ id: string }>`update app.categories set "status"='archived', "archivedAt"=now() where "businessId"=${businessId}::uuid and "id"=${categoryId}::uuid and "status" <> 'archived' returning "id"`.execute(c.transaction)).rows.length > 0; }
export async function setCategories(c: DatabaseContext, businessId: string, productId: string, ids: string[]): Promise<void> { await sql`delete from app.product_categories where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid`.execute(c.transaction); if (ids.length) await sql`insert into app.product_categories ("businessId","productId","categoryId") select ${businessId}::uuid, ${productId}::uuid, value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb) value`.execute(c.transaction); }

const modifierGroupAggregateCols = sql`coalesce(o."optionsCount", 0)::int as "optionsCount", coalesce(pg."productCount", 0)::int as "productCount"`;
const modifierGroupAggregateJoins = sql`
  left join lateral (select count(*) as "optionsCount" from app.modifier_options where "groupId" = g."id" and "status" <> 'archived') o on true
  left join lateral (select count(*) as "productCount" from app.product_modifier_groups where "groupId" = g."id") pg on true
`;
export async function listModifierGroups(c: DatabaseContext, businessId: string, storeId: string): Promise<(ModifierGroupRow & { optionsCount: number; productCount: number })[]> {
  return (await sql<ModifierGroupRow & { optionsCount: number; productCount: number }>`
    select g.*, ${modifierGroupAggregateCols} from app.modifier_groups g ${modifierGroupAggregateJoins}
    where g."businessId"=${businessId}::uuid and g."storeId"=${storeId}::uuid and g."status" <> 'archived'
    order by g."sortOrder", g."name"
  `.execute(c.transaction)).rows;
}
export async function findModifierGroup(c: DatabaseContext, businessId: string, groupId: string): Promise<(ModifierGroupRow & { optionsCount: number; productCount: number }) | undefined> {
  return (await sql<ModifierGroupRow & { optionsCount: number; productCount: number }>`
    select g.*, ${modifierGroupAggregateCols} from app.modifier_groups g ${modifierGroupAggregateJoins}
    where g."businessId"=${businessId}::uuid and g."id"=${groupId}::uuid limit 1
  `.execute(c.transaction)).rows[0];
}
export async function createModifierGroup(c: DatabaseContext, businessId: string, input: ModifierGroupInput): Promise<ModifierGroupRow> {
  return (await sql<ModifierGroupRow>`
    insert into app.modifier_groups ("businessId","storeId","name","description","selectionMode","minSelections","maxSelections","kind","branchIds")
    values (${businessId}::uuid,${input.storeId}::uuid,${input.name},${input.description ?? ''},${input.selectionMode ?? 'multiple'},${input.minSelections ?? 0},${input.maxSelections ?? null},${input.kind ?? 'modifier'},${input.branchIds ?? null}::uuid[])
    returning *
  `.execute(c.transaction)).rows[0]!;
}
export async function updateModifierGroup(c: DatabaseContext, businessId: string, groupId: string, input: ModifierGroupUpdateInput): Promise<ModifierGroupRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`); if (input.description !== undefined) fields.push(sql`"description"=${input.description}`); if (input.selectionMode !== undefined) fields.push(sql`"selectionMode"=${input.selectionMode}`); if (input.minSelections !== undefined) fields.push(sql`"minSelections"=${input.minSelections}`); if (input.maxSelections !== undefined) fields.push(sql`"maxSelections"=${input.maxSelections}`); if (input.kind !== undefined) fields.push(sql`"kind"=${input.kind}`); if (input.branchIds !== undefined) fields.push(sql`"branchIds"=${input.branchIds}::uuid[]`);
  if (!fields.length) return (await sql<ModifierGroupRow>`select * from app.modifier_groups where "businessId"=${businessId}::uuid and "id"=${groupId}::uuid limit 1`.execute(c.transaction)).rows[0];
  return (await sql<ModifierGroupRow>`update app.modifier_groups set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "id"=${groupId}::uuid returning *`.execute(c.transaction)).rows[0];
}
export async function archiveModifierGroup(c: DatabaseContext, businessId: string, groupId: string): Promise<boolean> { return (await sql<{ id: string }>`update app.modifier_groups set "status"='archived' where "businessId"=${businessId}::uuid and "id"=${groupId}::uuid and "status" <> 'archived' returning "id"`.execute(c.transaction)).rows.length > 0; }
export async function reorderModifierGroups(c: DatabaseContext, businessId: string, storeId: string, orderedIds: readonly string[]): Promise<void> {
  for (const [position, id] of orderedIds.entries()) await sql`update app.modifier_groups set "sortOrder"=${position} where "businessId"=${businessId}::uuid and "storeId"=${storeId}::uuid and "id"=${id}::uuid`.execute(c.transaction);
}
export async function listModifierOptions(c: DatabaseContext, businessId: string, groupId: string): Promise<ModifierOptionRow[]> { return (await sql<ModifierOptionRow>`select * from app.modifier_options where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid and "status" <> 'archived' order by "sortOrder","createdAt"`.execute(c.transaction)).rows; }
export async function createModifierOption(c: DatabaseContext, businessId: string, groupId: string, input: ModifierOptionInput): Promise<ModifierOptionRow> {
  const position = input.sortOrder ?? (await sql<{ next: number }>`select coalesce(max("sortOrder")+1, 0)::int as next from app.modifier_options where "groupId"=${groupId}::uuid`.execute(c.transaction)).rows[0]!.next;
  if (input.isDefault) await sql`update app.modifier_options set "isDefault"=false where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid`.execute(c.transaction);
  return (await sql<ModifierOptionRow>`
    insert into app.modifier_options ("businessId","groupId","name","priceAdjustmentMinor","sortOrder","isDefault")
    values (${businessId}::uuid,${groupId}::uuid,${input.name},${input.priceAdjustmentMinor ?? 0},${position},${input.isDefault ?? false})
    returning *
  `.execute(c.transaction)).rows[0]!;
}
export async function updateModifierOption(c: DatabaseContext, businessId: string, groupId: string, optionId: string, input: ModifierOptionUpdateInput): Promise<ModifierOptionRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name"=${input.name}`); if (input.priceAdjustmentMinor !== undefined) fields.push(sql`"priceAdjustmentMinor"=${input.priceAdjustmentMinor}`); if (input.isAvailable !== undefined) fields.push(sql`"isAvailable"=${input.isAvailable}`); if (input.branchIds !== undefined) fields.push(sql`"branchIds"=${input.branchIds}::uuid[]`);
  if (input.isDefault !== undefined) { if (input.isDefault) await sql`update app.modifier_options set "isDefault"=false where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid`.execute(c.transaction); fields.push(sql`"isDefault"=${input.isDefault}`); }
  if (!fields.length) return (await sql<ModifierOptionRow>`select * from app.modifier_options where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid and "id"=${optionId}::uuid limit 1`.execute(c.transaction)).rows[0];
  return (await sql<ModifierOptionRow>`update app.modifier_options set ${sql.join(fields, sql`, `)} where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid and "id"=${optionId}::uuid returning *`.execute(c.transaction)).rows[0];
}
export async function archiveModifierOption(c: DatabaseContext, businessId: string, groupId: string, optionId: string): Promise<boolean> { return (await sql<{ id: string }>`update app.modifier_options set "status"='archived' where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid and "id"=${optionId}::uuid and "status" <> 'archived' returning "id"`.execute(c.transaction)).rows.length > 0; }
export async function reorderModifierOptions(c: DatabaseContext, businessId: string, groupId: string, orderedIds: readonly string[]): Promise<void> {
  for (const [position, id] of orderedIds.entries()) await sql`update app.modifier_options set "sortOrder"=${position} where "businessId"=${businessId}::uuid and "groupId"=${groupId}::uuid and "id"=${id}::uuid`.execute(c.transaction);
}
export async function listProductModifierGroups(c: DatabaseContext, businessId: string, productId: string): Promise<AttachedModifierGroup[]> {
  return (await sql<AttachedModifierGroup>`
    select g."id", g."name", g."kind", pg."sortOrder" from app.product_modifier_groups pg
    join app.modifier_groups g on g."id" = pg."groupId"
    where pg."businessId"=${businessId}::uuid and pg."productId"=${productId}::uuid
    order by pg."sortOrder"
  `.execute(c.transaction)).rows;
}
export async function attachModifierGroup(c: DatabaseContext, businessId: string, productId: string, groupId: string): Promise<void> {
  const position = (await sql<{ next: number }>`select coalesce(max("sortOrder")+1, 0)::int as next from app.product_modifier_groups where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid`.execute(c.transaction)).rows[0]!.next;
  await sql`insert into app.product_modifier_groups ("businessId","productId","groupId","sortOrder") values (${businessId}::uuid,${productId}::uuid,${groupId}::uuid,${position}) on conflict ("productId","groupId") do nothing`.execute(c.transaction);
}
export async function detachModifierGroup(c: DatabaseContext, businessId: string, productId: string, groupId: string): Promise<void> { await sql`delete from app.product_modifier_groups where "businessId"=${businessId}::uuid and "productId"=${productId}::uuid and "groupId"=${groupId}::uuid`.execute(c.transaction); }
