import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { conflictError, validationError } from "../../shared/errors.js";
import type { CreateFulfillmentInput } from "./fulfillment.types.js";
export async function create(c: DatabaseContext, businessId: string, userId: string, requestId: string, i: CreateFulfillmentInput) {
  const order = (await sql<{ id: string; locationId: string | null }>`select "id","locationId" from app.orders where "id"=${i.orderId}::uuid and "businessId"=${businessId}::uuid and "status"='placed' for update`.execute(c.transaction)).rows[0];
  if (!order) throw conflictError("This order can't be fulfilled — it may be cancelled or already fulfilled.");
  const f = (await sql<{ id: string }>`insert into app.fulfillments ("businessId","orderId","inventoryLocationId","method","trackingReference","createdBy") values (${businessId}::uuid,${i.orderId}::uuid,${i.inventoryLocationId}::uuid,${i.method},${i.trackingReference ?? null},${userId}::uuid) returning "id"`.execute(c.transaction)).rows[0]!;
  for (const line of i.lines) {
    // Products that don't track stock (services, made-to-order food) have no
    // inventory item: the line is fulfilled without touching stock.
    const ol = (await sql<{ inventoryItemId: string | null; tracksStock: boolean; quantity: number }>`select il."id" "inventoryItemId",coalesce(p."trackInventory",false) "tracksStock",ol."quantity" from app.order_lines ol join app.product_variants v on v."id"=ol."productVariantId" and v."businessId"=ol."businessId" join app.products p on p."id"=v."productId" and p."businessId"=v."businessId" left join app.inventory_items il on il."variantId"=v."id" and il."businessId"=v."businessId" where ol."id"=${line.orderLineId}::uuid and ol."orderId"=${i.orderId}::uuid and ol."businessId"=${businessId}::uuid`.execute(c.transaction)).rows[0];
    if (!ol) throw validationError("That line isn't on this order.");
    if (line.quantity > ol.quantity) throw validationError("Fulfillment quantity exceeds order line");
    const prior = (await sql<{ quantity: string }>`select coalesce(sum("quantity"),0)::text "quantity" from app.fulfillment_lines where "businessId"=${businessId}::uuid and "orderLineId"=${line.orderLineId}::uuid`.execute(c.transaction)).rows[0]?.quantity ?? "0";
    if (BigInt(prior) + BigInt(line.quantity) > BigInt(ol.quantity)) throw validationError("Fulfillment quantity exceeds remaining quantity");
    if (!ol.tracksStock || !ol.inventoryItemId) {
      await sql`insert into app.fulfillment_lines ("businessId","fulfillmentId","orderLineId","quantity") values (${businessId}::uuid,${f.id}::uuid,${line.orderLineId}::uuid,${line.quantity})`.execute(c.transaction);
      continue;
    }
    const stock = (await sql<{ id: string }>`select "id" from app.stock_balances where "businessId"=${businessId}::uuid and "inventoryItemId"=${ol.inventoryItemId}::uuid and "inventoryLocationId"=${i.inventoryLocationId}::uuid and "onHand"-"reserved">=${line.quantity} for update`.execute(c.transaction)).rows[0];
    if (!stock) throw conflictError("Not enough stock at this location to fulfil the order.");
    const tx = (await sql<{ id: string }>`insert into app.stock_transactions ("businessId","type","reason","actorUserId","requestId","idempotencyKey") values (${businessId}::uuid,'sale','Fulfillment',${userId}::uuid,${requestId},${f.id + line.orderLineId}) returning "id"`.execute(c.transaction)).rows[0]!;
    await sql`insert into app.stock_movements ("businessId","transactionId","inventoryItemId","inventoryLocationId","quantity") values (${businessId}::uuid,${tx.id}::uuid,${ol.inventoryItemId}::uuid,${i.inventoryLocationId}::uuid,${-line.quantity})`.execute(c.transaction);
    await sql`update app.stock_balances set "onHand"="onHand"-${line.quantity} where "id"=${stock.id}::uuid`.execute(c.transaction);
    await sql`insert into app.fulfillment_lines ("businessId","fulfillmentId","orderLineId","quantity") values (${businessId}::uuid,${f.id}::uuid,${line.orderLineId}::uuid,${line.quantity})`.execute(c.transaction);
  }
  await sql`update app.fulfillments set "status"='fulfilled',"fulfilledAt"=now() where "id"=${f.id}::uuid`.execute(c.transaction);
  await sql`update app.orders set "fulfillmentStatus"=case when not exists(select 1 from app.order_lines ol where ol."orderId"=${i.orderId}::uuid and ol."businessId"=${businessId}::uuid and (select coalesce(sum(fl."quantity"),0) from app.fulfillment_lines fl where fl."orderLineId"=ol."id")<ol."quantity") then 'fulfilled' else 'partial' end,"status"=case when not exists(select 1 from app.order_lines ol where ol."orderId"=${i.orderId}::uuid and ol."businessId"=${businessId}::uuid and (select coalesce(sum(fl."quantity"),0) from app.fulfillment_lines fl where fl."orderLineId"=ol."id")<ol."quantity") then 'fulfilled' else "status" end where "id"=${i.orderId}::uuid and "businessId"=${businessId}::uuid`.execute(c.transaction);
  return f;
}
