import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { BusinessCreateInput, BusinessListRow, BusinessRow, BusinessUpdateInput } from "./businesses.types.js";

export async function listBusinesses(context: DatabaseContext): Promise<BusinessListRow[]> {
  const result = await sql<BusinessListRow>`
    select business.*,
      coalesce(array_agg(distinct role."code") filter (where role."code" is not null), '{}')::text[] as "roleCodes",
      store."id" as "defaultStoreId", store."name" as "defaultStoreName", store."slug" as "defaultStoreSlug"
    from app.businesses business
    join app.business_memberships membership on membership."businessId" = business."id"
      and membership."userId"::text = app.current_user_id() and membership."status" = 'active'
    join app.stores store on store."businessId" = business."id" and store."isDefault" and store."status" <> 'archived'
    left join app.membership_roles membership_role on membership_role."membershipId" = membership."id"
    left join app.roles role on role."id" = membership_role."roleId"
    where business."status" <> 'archived'
    group by business."id", store."id"
    order by business."createdAt", business."id"
  `.execute(context.transaction);
  return result.rows;
}

export async function findBusiness(context: DatabaseContext, businessId: string): Promise<BusinessListRow | undefined> {
  const result = await sql<BusinessListRow>`
    select business.*,
      coalesce(array_agg(distinct role."code") filter (where role."code" is not null), '{}')::text[] as "roleCodes",
      store."id" as "defaultStoreId", store."name" as "defaultStoreName", store."slug" as "defaultStoreSlug"
    from app.businesses business
    join app.business_memberships membership on membership."businessId" = business."id"
      and membership."userId"::text = app.current_user_id() and membership."status" = 'active'
    join app.stores store on store."businessId" = business."id" and store."isDefault" and store."status" <> 'archived'
    left join app.membership_roles membership_role on membership_role."membershipId" = membership."id"
    left join app.roles role on role."id" = membership_role."roleId"
    where business."id" = ${businessId}::uuid and business."status" <> 'archived'
    group by business."id", store."id"
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createBusiness(context: DatabaseContext, input: BusinessCreateInput, storeSlug: string): Promise<BusinessRow> {
  const result = await sql<BusinessRow>`
    select * from app.create_business_with_default_store(
      ${input.displayName}, ${input.defaultCurrency}, ${input.timezone},
      ${input.primaryVertical ?? null}, ${storeSlug}
    )
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function setBusinessContext(context: DatabaseContext, businessId: string): Promise<void> {
  await sql`select set_config('app.business_id', ${businessId}, true)`.execute(context.transaction);
}

export async function updateBusiness(context: DatabaseContext, businessId: string, input: BusinessUpdateInput): Promise<BusinessRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.displayName !== undefined) fields.push(sql`"displayName"=${input.displayName}`);
  if (input.defaultCurrency !== undefined) fields.push(sql`"defaultCurrency"=${input.defaultCurrency}`);
  if (input.timezone !== undefined) fields.push(sql`"timezone"=${input.timezone}`);
  if (input.primaryVertical !== undefined) fields.push(sql`"primaryVertical"=${input.primaryVertical}`);
  const result = await sql<BusinessRow>`
    update app.businesses set ${sql.join(fields, sql`, `)}
    where "id"=${businessId}::uuid and "status" <> 'archived'
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}

export async function archiveBusiness(context: DatabaseContext, businessId: string): Promise<BusinessRow | undefined> {
  const result = await sql<BusinessRow>`
    update app.businesses set "status"='archived', "archivedAt"=now()
    where "id"=${businessId}::uuid and "status" <> 'archived'
    returning *
  `.execute(context.transaction);
  return result.rows[0];
}
