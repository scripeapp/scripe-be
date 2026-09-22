import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { ReturnLineCondition, ReturnLineRow, ReturnRow } from "./returns.types.js";

export interface OrderLineForReturn {
  readonly inventoryItemId: string | null;
  readonly unitPriceMinor: string;
  readonly quantity: number;
}

export async function findOrderLineForReturn(c: DatabaseContext, businessId: string, orderId: string, orderLineId: string): Promise<OrderLineForReturn | undefined> {
  const result = await sql<OrderLineForReturn>`
    select il."id" as "inventoryItemId", ol."unitPriceMinor", ol."quantity"
    from app.order_lines ol
    join app.product_variants v on v."id" = ol."productVariantId" and v."businessId" = ol."businessId"
    left join app.inventory_items il on il."variantId" = v."id" and il."businessId" = v."businessId"
    where ol."id" = ${orderLineId}::uuid and ol."orderId" = ${orderId}::uuid and ol."businessId" = ${businessId}::uuid
  `.execute(c.transaction);
  return result.rows[0];
}

export async function sumReturnedQuantity(c: DatabaseContext, businessId: string, orderLineId: string): Promise<number> {
  const result = await sql<{ quantity: string }>`
    select coalesce(sum("quantity"), 0)::text as "quantity" from app.return_lines
    where "businessId" = ${businessId}::uuid and "orderLineId" = ${orderLineId}::uuid
  `.execute(c.transaction);
  return Number(result.rows[0]?.quantity ?? "0");
}

export async function verifyOrder(c: DatabaseContext, businessId: string, orderId: string): Promise<boolean> {
  const result = await sql<{ id: string }>`select "id" from app.orders where "id" = ${orderId}::uuid and "businessId" = ${businessId}::uuid`.execute(c.transaction);
  return result.rows.length > 0;
}

export async function createReturn(
  c: DatabaseContext,
  businessId: string,
  userId: string,
  orderId: string,
  reason: string,
  inventoryLocationId: string | null,
  refundableAmountMinor: bigint,
): Promise<ReturnRow> {
  const result = await sql<ReturnRow>`
    insert into app.returns ("businessId", "orderId", "reason", "inventoryLocationId", "refundableAmountMinor", "createdBy")
    values (${businessId}::uuid, ${orderId}::uuid, ${reason}, ${inventoryLocationId ?? null}::uuid, ${refundableAmountMinor.toString()}::bigint, ${userId}::uuid)
    returning "id", "businessId", "orderId", "reason", "inventoryLocationId", "refundableAmountMinor"::text, "createdBy", "createdAt"
  `.execute(c.transaction);
  return result.rows[0]!;
}

export async function createReturnLine(
  c: DatabaseContext,
  businessId: string,
  returnId: string,
  orderLineId: string,
  quantity: number,
  condition: ReturnLineCondition,
  restocked: boolean,
  amountMinor: bigint,
): Promise<ReturnLineRow> {
  const result = await sql<ReturnLineRow>`
    insert into app.return_lines ("businessId", "returnId", "orderLineId", "quantity", "condition", "restocked", "amountMinor")
    values (${businessId}::uuid, ${returnId}::uuid, ${orderLineId}::uuid, ${quantity}, ${condition}, ${restocked}, ${amountMinor.toString()}::bigint)
    returning "id", "businessId", "returnId", "orderLineId", "quantity", "condition", "restocked", "amountMinor"::text, "createdAt"
  `.execute(c.transaction);
  return result.rows[0]!;
}

/** Posts a positive stock movement for a restocked return line and upserts the balance. Mirrors inventory.repository.ts's postMovement for additions. */
export async function restockLine(
  c: DatabaseContext,
  businessId: string,
  inventoryItemId: string,
  inventoryLocationId: string,
  quantity: number,
  userId: string,
  requestId: string,
  idempotencyKey: string,
): Promise<void> {
  const tx = (await sql<{ id: string }>`
    insert into app.stock_transactions ("businessId", "type", "reason", "actorUserId", "requestId", "idempotencyKey")
    values (${businessId}::uuid, 'return', 'Return restock', ${userId}::uuid, ${requestId}, ${idempotencyKey})
    on conflict ("businessId", "idempotencyKey") do nothing
    returning "id"
  `.execute(c.transaction)).rows[0];
  if (!tx) return;

  await sql`
    insert into app.stock_movements ("businessId", "transactionId", "inventoryItemId", "inventoryLocationId", "quantity")
    values (${businessId}::uuid, ${tx.id}::uuid, ${inventoryItemId}::uuid, ${inventoryLocationId}::uuid, ${quantity})
  `.execute(c.transaction);

  await sql`
    insert into app.stock_balances ("businessId", "inventoryItemId", "inventoryLocationId", "onHand")
    values (${businessId}::uuid, ${inventoryItemId}::uuid, ${inventoryLocationId}::uuid, ${quantity})
    on conflict ("businessId", "inventoryItemId", "inventoryLocationId") do update set "onHand" = app.stock_balances."onHand" + excluded."onHand"
  `.execute(c.transaction);
}

export async function listReturns(c: DatabaseContext, businessId: string, orderId?: string): Promise<ReturnRow[]> {
  const orderFilter = orderId ? sql`and "orderId" = ${orderId}::uuid` : sql``;
  const result = await sql<ReturnRow>`
    select "id", "businessId", "orderId", "reason", "inventoryLocationId", "refundableAmountMinor"::text, "createdBy", "createdAt"
    from app.returns where "businessId" = ${businessId}::uuid ${orderFilter}
    order by "createdAt" desc
  `.execute(c.transaction);
  return result.rows;
}

export async function findReturn(c: DatabaseContext, businessId: string, returnId: string): Promise<ReturnRow | undefined> {
  const result = await sql<ReturnRow>`
    select "id", "businessId", "orderId", "reason", "inventoryLocationId", "refundableAmountMinor"::text, "createdBy", "createdAt"
    from app.returns where "businessId" = ${businessId}::uuid and "id" = ${returnId}::uuid
  `.execute(c.transaction);
  return result.rows[0];
}

export async function listReturnLines(c: DatabaseContext, businessId: string, returnId: string): Promise<ReturnLineRow[]> {
  const result = await sql<ReturnLineRow>`
    select "id", "businessId", "returnId", "orderLineId", "quantity", "condition", "restocked", "amountMinor"::text, "createdAt"
    from app.return_lines where "businessId" = ${businessId}::uuid and "returnId" = ${returnId}::uuid
    order by "createdAt"
  `.execute(c.transaction);
  return result.rows;
}
