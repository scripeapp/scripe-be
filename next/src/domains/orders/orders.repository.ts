import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { conflictError } from "../../shared/errors.js";
import type { CartLineRow } from "../carts/carts.types.js";
import type { OrderLineRow, OrderRow } from "./orders.types.js";
interface PriceLookup { readonly productId: string; readonly sku: string | null; readonly description: string; readonly unit: string | null; }
export async function find(c: DatabaseContext, businessId: string, orderId: string): Promise<OrderRow | undefined> { return (await sql<OrderRow>`select * from app.orders where "businessId"=${businessId}::uuid and "id"=${orderId}::uuid`.execute(c.transaction)).rows[0]; }
export async function lines(c: DatabaseContext, businessId: string, orderId: string): Promise<OrderLineRow[]> { return (await sql<OrderLineRow>`select * from app.order_lines where "businessId"=${businessId}::uuid and "orderId"=${orderId}::uuid order by "createdAt","id"`.execute(c.transaction)).rows; }
export async function list(c: DatabaseContext, businessId: string, status?: string, limit = 50): Promise<OrderRow[]> { const statusSql: RawBuilder<unknown> = status ? sql`and "status"=${status}` : sql``; return (await sql<OrderRow>`select * from app.orders where "businessId"=${businessId}::uuid ${statusSql} order by "createdAt" desc,"id" desc limit ${limit}`.execute(c.transaction)).rows; }

export interface PricedLine { readonly line: CartLineRow; readonly productId: string; readonly sku: string | null; readonly description: string; readonly unitMinor: string; readonly lineTotalMinor: string; }

/** Resolves each cart line's product and active price. Pure lookup — no writes, so discounts can be evaluated against the result before the order is created. */
export async function priceCartLines(c: DatabaseContext, businessId: string, lines: CartLineRow[], locationId: string | null): Promise<PricedLine[]> {
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const locationClause = locationId ? sql`and (pp."locationId" is null or pp."locationId"=${locationId}::uuid)` : sql`and pp."locationId" is null`;
    const query = sql<PriceLookup>`select p."id" as "productId", v."sku", p."name" as "description", (select pp."amountMinor"::text from app.product_prices pp where pp."businessId"=${businessId}::uuid and pp."productVariantId"=v."id" and pp."assetCode"=${line.assetCode} and pp."status"='active' and pp."effectiveFrom" <= now() and (pp."effectiveTo" is null or pp."effectiveTo" > now()) ${locationClause} order by (pp."locationId" is not null) desc, pp."effectiveFrom" desc limit 1) as "unit" from app.product_variants v join app.products p on p."id"=v."productId" and p."businessId"=v."businessId" where v."id"=${line.productVariantId}::uuid and v."businessId"=${businessId}::uuid and v."status"='active'`;
    const row = (await query.execute(c.transaction)).rows[0];
    if (!row?.unit) throw conflictError(`No active price for variant ${line.productVariantId}`);
    const lineTotal = BigInt(row.unit) * BigInt(line.quantity);
    priced.push({ line, productId: row.productId, sku: row.sku, description: row.description, unitMinor: row.unit, lineTotalMinor: lineTotal.toString() });
  }
  return priced;
}

/** Inserts the order and its immutable lines from already-priced cart lines. discountMinor is applied at the order header only — order lines are not individually prorated. */
export async function createOrderFromPricedLines(
  c: DatabaseContext,
  businessId: string,
  userId: string,
  cart: { id: string; storeId: string; channelId: string; customerPartyId: string | null; currency: string },
  priced: PricedLine[],
  locationId: string | null,
  discountMinor: bigint,
): Promise<OrderRow> {
  const number = `ORD-${Date.now().toString(36).toUpperCase()}-${cart.id.slice(0, 8).toUpperCase()}`;
  const subtotal = priced.reduce((sum, item) => sum + BigInt(item.lineTotalMinor), 0n);
  const total = subtotal - discountMinor > 0n ? subtotal - discountMinor : 0n;
  const order = (await sql<OrderRow>`insert into app.orders ("businessId","orderNumber","storeId","channelId","locationId","customerPartyId","cartId","currency","subtotalMinor","discountMinor","totalMinor","createdBy") values (${businessId}::uuid,${number},${cart.storeId}::uuid,${cart.channelId}::uuid,${locationId ?? null}::uuid,${cart.customerPartyId ?? null}::uuid,${cart.id}::uuid,${cart.currency},${subtotal.toString()},${discountMinor.toString()},${total.toString()},${userId}::uuid) returning *`.execute(c.transaction)).rows[0]!;
  for (const item of priced) { await sql`insert into app.order_lines ("businessId","orderId","productVariantId","sku","description","quantity","unitPriceMinor","lineTotalMinor","assetCode","selectedModifiers") values (${businessId}::uuid,${order.id}::uuid,${item.line.productVariantId}::uuid,${item.sku},${item.description},${item.line.quantity},${item.unitMinor},${item.lineTotalMinor},${item.line.assetCode},${JSON.stringify(item.line.selectedModifiers)}::jsonb)`.execute(c.transaction); }
  return order;
}
