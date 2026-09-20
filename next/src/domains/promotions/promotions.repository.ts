import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { DiscountCreateInput, DiscountRow, DiscountUpdateInput } from "./promotions.types.js";

/** Builds a `uuid[]` SQL expression from a JS string array, defaulting to '{}' rather than null. */
function toUuidArray(ids: readonly string[] | undefined): RawBuilder<unknown> {
  return sql`coalesce((select array_agg(value::uuid) from jsonb_array_elements_text(${JSON.stringify(ids ?? [])}::jsonb) value), '{}'::uuid[])`;
}

const DISCOUNT_COLUMNS = sql`
  "id", "businessId", "kind", "name", "code", "type", "percentageBps", "fixedAmountMinor"::text as "fixedAmountMinor",
  "isActive", "maxUsage", "usageCount", "oneUsePerCustomer", "startsAt", "expiresAt", "appliesTo", "productIds",
  "trigger", "triggerSpendMinor"::text as "triggerSpendMinor", "triggerQuantity", "qualificationProductIds",
  "allowCodeOnTop", "showOnStorefront", "createdBy", "createdAt", "updatedAt", "archivedAt"
`;

export async function listDiscounts(context: DatabaseContext, businessId: string): Promise<DiscountRow[]> {
  const result = await sql<DiscountRow>`
    select ${DISCOUNT_COLUMNS} from app.discounts
    where "businessId" = ${businessId}::uuid and "archivedAt" is null
    order by "createdAt" desc
  `.execute(context.transaction);
  return result.rows;
}

export async function findDiscount(context: DatabaseContext, businessId: string, discountId: string): Promise<DiscountRow | undefined> {
  const result = await sql<DiscountRow>`
    select ${DISCOUNT_COLUMNS} from app.discounts where "businessId" = ${businessId}::uuid and "id" = ${discountId}::uuid limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function createDiscount(context: DatabaseContext, businessId: string, userId: string, input: DiscountCreateInput): Promise<DiscountRow> {
  const result = await sql<DiscountRow>`
    insert into app.discounts (
      "businessId", "kind", "name", "code", "type", "percentageBps", "fixedAmountMinor",
      "isActive", "maxUsage", "oneUsePerCustomer", "startsAt", "expiresAt", "appliesTo", "productIds",
      "trigger", "triggerSpendMinor", "triggerQuantity", "qualificationProductIds",
      "allowCodeOnTop", "showOnStorefront", "createdBy"
    ) values (
      ${businessId}::uuid, ${input.kind}, ${input.name}, ${input.code ?? null}, ${input.type}, ${input.percentageBps ?? null}, ${input.fixedAmountMinor ?? null},
      ${input.isActive ?? true}, ${input.maxUsage ?? null}, ${input.oneUsePerCustomer ?? false}, ${input.startsAt ?? null}::timestamptz, ${input.expiresAt ?? null}::timestamptz,
      ${input.appliesTo ?? "all"}, ${toUuidArray(input.productIds)}, ${input.trigger ?? null}, ${input.triggerSpendMinor ?? null}, ${input.triggerQuantity ?? null},
      ${toUuidArray(input.qualificationProductIds)}, ${input.allowCodeOnTop ?? false}, ${input.showOnStorefront ?? true}, ${userId}::uuid
    )
    returning ${DISCOUNT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0]!;
}

export async function updateDiscount(context: DatabaseContext, businessId: string, discountId: string, input: DiscountUpdateInput): Promise<DiscountRow | undefined> {
  const fields: RawBuilder<unknown>[] = [];
  if (input.name !== undefined) fields.push(sql`"name" = ${input.name}`);
  if (input.code !== undefined) fields.push(sql`"code" = ${input.code}`);
  if (input.percentageBps !== undefined) fields.push(sql`"percentageBps" = ${input.percentageBps}`);
  if (input.fixedAmountMinor !== undefined) fields.push(sql`"fixedAmountMinor" = ${input.fixedAmountMinor}`);
  if (input.isActive !== undefined) fields.push(sql`"isActive" = ${input.isActive}`);
  if (input.maxUsage !== undefined) fields.push(sql`"maxUsage" = ${input.maxUsage}`);
  if (input.oneUsePerCustomer !== undefined) fields.push(sql`"oneUsePerCustomer" = ${input.oneUsePerCustomer}`);
  if (input.startsAt !== undefined) fields.push(sql`"startsAt" = ${input.startsAt}::timestamptz`);
  if (input.expiresAt !== undefined) fields.push(sql`"expiresAt" = ${input.expiresAt}::timestamptz`);
  if (input.appliesTo !== undefined) fields.push(sql`"appliesTo" = ${input.appliesTo}`);
  if (input.productIds !== undefined) fields.push(sql`"productIds" = ${toUuidArray(input.productIds)}`);
  if (input.trigger !== undefined) fields.push(sql`"trigger" = ${input.trigger}`);
  if (input.triggerSpendMinor !== undefined) fields.push(sql`"triggerSpendMinor" = ${input.triggerSpendMinor}`);
  if (input.triggerQuantity !== undefined) fields.push(sql`"triggerQuantity" = ${input.triggerQuantity}`);
  if (input.qualificationProductIds !== undefined) fields.push(sql`"qualificationProductIds" = ${toUuidArray(input.qualificationProductIds)}`);
  if (input.allowCodeOnTop !== undefined) fields.push(sql`"allowCodeOnTop" = ${input.allowCodeOnTop}`);
  if (input.showOnStorefront !== undefined) fields.push(sql`"showOnStorefront" = ${input.showOnStorefront}`);
  if (fields.length === 0) return findDiscount(context, businessId, discountId);

  const result = await sql<DiscountRow>`
    update app.discounts set ${sql.join(fields, sql`, `)}
    where "businessId" = ${businessId}::uuid and "id" = ${discountId}::uuid and "archivedAt" is null
    returning ${DISCOUNT_COLUMNS}
  `.execute(context.transaction);
  return result.rows[0];
}

export async function archiveDiscount(context: DatabaseContext, businessId: string, discountId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`
    update app.discounts set "archivedAt" = now(), "isActive" = false
    where "businessId" = ${businessId}::uuid and "id" = ${discountId}::uuid and "archivedAt" is null
    returning "id"
  `.execute(context.transaction);
  return result.rows.length > 0;
}

/** Active, in-window automatic discounts. Locks the rows for update when `forUpdate` is true (checkout reservation). */
export async function listAvailableAutomaticDiscounts(context: DatabaseContext, businessId: string, forUpdate: boolean): Promise<DiscountRow[]> {
  const lock = forUpdate ? sql`for update` : sql``;
  const result = await sql<DiscountRow>`
    select ${DISCOUNT_COLUMNS} from app.discounts
    where "businessId" = ${businessId}::uuid and "archivedAt" is null and "kind" = 'automatic' and "isActive"
      and (coalesce("maxUsage", 2147483647) > "usageCount")
      and (("startsAt" is null) or ("startsAt" <= now()))
      and (("expiresAt" is null) or ("expiresAt" > now()))
    ${lock}
  `.execute(context.transaction);
  return result.rows;
}

/** The named code discount, active or not (validity is checked by the caller). Locks for update when `forUpdate` is true. */
export async function findDiscountByCode(context: DatabaseContext, businessId: string, code: string, forUpdate: boolean): Promise<DiscountRow | undefined> {
  const lock = forUpdate ? sql`for update` : sql``;
  const result = await sql<DiscountRow>`
    select ${DISCOUNT_COLUMNS} from app.discounts
    where "businessId" = ${businessId}::uuid and "archivedAt" is null and "kind" = 'code' and "code" = ${code.trim().toUpperCase()}
    ${lock}
    limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findCustomerRedemptions(context: DatabaseContext, businessId: string, customerPartyId: string, discountIds: readonly string[]): Promise<Set<string>> {
  if (discountIds.length === 0) return new Set();
  const result = await sql<{ discountId: string }>`
    select "discountId" from app.discount_redemptions
    where "businessId" = ${businessId}::uuid and "customerPartyId" = ${customerPartyId}::uuid
      and "discountId" in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(discountIds)}::jsonb) value)
  `.execute(context.transaction);
  return new Set(result.rows.map((row) => row.discountId));
}

export async function hasPriorOrder(context: DatabaseContext, businessId: string, customerPartyId: string): Promise<boolean> {
  const result = await sql<{ exists: boolean }>`
    select exists(select 1 from app.orders where "businessId" = ${businessId}::uuid and "customerPartyId" = ${customerPartyId}::uuid) as "exists"
  `.execute(context.transaction);
  return result.rows[0]?.exists === true;
}

export interface RedemptionToRecord {
  readonly discountId: string;
  readonly amountMinor: string;
}

/** Increments usage and records the redemption for each applied discount. The discount rows must already be locked (see listAvailableAutomaticDiscounts/findDiscountByCode with forUpdate=true) within the same transaction as the order this redemption belongs to. */
export async function recordRedemptions(context: DatabaseContext, businessId: string, orderId: string, customerPartyId: string | null, redemptions: readonly RedemptionToRecord[]): Promise<void> {
  for (const redemption of redemptions) {
    await sql`update app.discounts set "usageCount" = "usageCount" + 1 where "id" = ${redemption.discountId}::uuid`.execute(context.transaction);
    await sql`
      insert into app.discount_redemptions ("businessId", "discountId", "orderId", "customerPartyId", "amountMinor")
      values (${businessId}::uuid, ${redemption.discountId}::uuid, ${orderId}::uuid, ${customerPartyId ?? null}::uuid, ${redemption.amountMinor}::bigint)
    `.execute(context.transaction);
  }
}
