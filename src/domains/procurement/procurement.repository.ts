import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type {
  GoodsReceiptInput,
  GoodsReceiptLineRow,
  GoodsReceiptRow,
  ListGoodsReceiptsFilter,
  ListPurchaseOrdersFilter,
  PurchaseOrderInput,
  PurchaseOrderLineInput,
  PurchaseOrderLineRow,
  PurchaseOrderRow,
  UpdatePurchaseOrderInput,
} from "./procurement.types.js";

async function resolveInventoryItemId(c: DatabaseContext, businessId: string, line: PurchaseOrderLineInput): Promise<string> {
  if (line.inventoryItemId) return line.inventoryItemId;

  if (line.variantId) {
    const existing = (await sql<{ id: string }>`
      select "id" from app.inventory_items
      where "businessId" = ${businessId}::uuid and "variantId" = ${line.variantId}::uuid
      limit 1
    `.execute(c.transaction)).rows[0];
    if (existing) return existing.id;

    const variant = (await sql<{ name: string; sku: string | null }>`
      select "name", "sku" from app.product_variants
      where "id" = ${line.variantId}::uuid and "businessId" = ${businessId}::uuid
      limit 1
    `.execute(c.transaction)).rows[0];

    if (variant) {
      const created = (await sql<{ id: string }>`
        insert into app.inventory_items ("businessId", "variantId", "name", "sku")
        values (${businessId}::uuid, ${line.variantId}::uuid, ${variant.name}, ${variant.sku})
        returning "id"
      `.execute(c.transaction)).rows[0]!;
      return created.id;
    }
  }

  if (line.productId) {
    const existingFromProduct = (await sql<{ id: string }>`
      select i."id"
      from app.product_variants v
      join app.inventory_items i on i."variantId" = v."id" and i."businessId" = v."businessId"
      where v."businessId" = ${businessId}::uuid and v."productId" = ${line.productId}::uuid
      order by v."isDefault" desc
      limit 1
    `.execute(c.transaction)).rows[0];
    if (existingFromProduct) return existingFromProduct.id;

    const defaultVariant = (await sql<{ id: string; name: string; sku: string | null }>`
      select "id", "name", "sku" from app.product_variants
      where "productId" = ${line.productId}::uuid and "businessId" = ${businessId}::uuid
      order by "isDefault" desc
      limit 1
    `.execute(c.transaction)).rows[0];

    if (defaultVariant) {
      const created = (await sql<{ id: string }>`
        insert into app.inventory_items ("businessId", "variantId", "name", "sku")
        values (${businessId}::uuid, ${defaultVariant.id}::uuid, ${defaultVariant.name}, ${defaultVariant.sku})
        returning "id"
      `.execute(c.transaction)).rows[0]!;
      return created.id;
    }
  }

  throw new Error("Line item must have an inventoryItemId, variantId, or productId");
}

export async function createPurchaseOrder(c: DatabaseContext, businessId: string, userId: string, input: PurchaseOrderInput): Promise<{ id: string }> {
  const order = (await sql<{ id: string }>`
    insert into app.purchase_orders ("businessId", "supplierAccountId", "storeId", "orderNumber", "expectedAt", "notes", "createdBy")
    values (${businessId}::uuid, ${input.supplierAccountId}::uuid, ${input.storeId}::uuid, ${input.orderNumber}, ${input.expectedAt ?? null}::timestamptz, ${input.notes ?? ''}, ${userId}::uuid)
    returning "id"
  `.execute(c.transaction)).rows[0]!;

  for (const line of input.lines) {
    const inventoryItemId = await resolveInventoryItemId(c, businessId, line);
    await sql`
      insert into app.purchase_order_lines ("businessId", "purchaseOrderId", "inventoryItemId", "quantityOrdered", "unitCostMinor")
      values (${businessId}::uuid, ${order.id}::uuid, ${inventoryItemId}::uuid, ${line.quantityOrdered}, ${line.unitCostMinor})
    `.execute(c.transaction);
  }

  return order;
}

export async function listPurchaseOrders(c: DatabaseContext, businessId: string, f: ListPurchaseOrdersFilter): Promise<{ purchaseOrders: PurchaseOrderRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`po."businessId" = ${businessId}::uuid`];
  if (f.storeId) clauses.push(sql`po."storeId" = ${f.storeId}::uuid`);
  if (f.supplierAccountId) clauses.push(sql`po."supplierAccountId" = ${f.supplierAccountId}::uuid`);
  if (f.status) clauses.push(sql`po."status" = ${f.status}`);
  if (f.search) clauses.push(sql`(po."orderNumber" ilike ${`%${f.search}%`} or sp."displayName" ilike ${`%${f.search}%`})`);

  const whereClause = sql.join(clauses, sql` and `);
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countResult = await sql<{ count: string }>`
    select count(*)::text as "count"
    from app.purchase_orders po
    left join app.supplier_accounts s on s."id" = po."supplierAccountId" and s."businessId" = po."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    where ${whereClause}
  `.execute(c.transaction);
  const total = Number(countResult.rows[0]?.count ?? 0);

  const ordersResult = await sql<PurchaseOrderRow>`
    select
      po."id",
      po."businessId",
      po."storeId",
      po."supplierAccountId",
      po."status",
      po."orderNumber",
      po."orderedAt"::text as "orderedAt",
      po."expectedAt"::text as "expectedAt",
      po."notes",
      po."createdBy",
      po."createdAt"::text as "createdAt",
      po."updatedAt"::text as "updatedAt",
      sp."displayName" as "supplierName",
      st."name" as "storeName",
      coalesce((
        select count(*)::int
        from app.purchase_order_lines pol
        where pol."purchaseOrderId" = po."id" and pol."businessId" = po."businessId"
      ), 0) as "itemsCount",
      coalesce((
        select sum("quantityOrdered" * "unitCostMinor")::text
        from app.purchase_order_lines pol
        where pol."purchaseOrderId" = po."id" and pol."businessId" = po."businessId"
      ), '0') as "totalMinor"
    from app.purchase_orders po
    left join app.supplier_accounts s on s."id" = po."supplierAccountId" and s."businessId" = po."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    left join app.stores st on st."id" = po."storeId" and st."businessId" = po."businessId"
    where ${whereClause}
    order by po."createdAt" desc
    limit ${pageSize} offset ${offset}
  `.execute(c.transaction);

  return { purchaseOrders: ordersResult.rows, total };
}

export async function findPurchaseOrderById(c: DatabaseContext, businessId: string, orderId: string): Promise<PurchaseOrderRow | undefined> {
  const result = await sql<PurchaseOrderRow>`
    select
      po."id",
      po."businessId",
      po."storeId",
      po."supplierAccountId",
      po."status",
      po."orderNumber",
      po."orderedAt"::text as "orderedAt",
      po."expectedAt"::text as "expectedAt",
      po."notes",
      po."createdBy",
      po."createdAt"::text as "createdAt",
      po."updatedAt"::text as "updatedAt",
      sp."displayName" as "supplierName",
      st."name" as "storeName",
      coalesce((
        select count(*)::int
        from app.purchase_order_lines pol
        where pol."purchaseOrderId" = po."id" and pol."businessId" = po."businessId"
      ), 0) as "itemsCount",
      coalesce((
        select sum("quantityOrdered" * "unitCostMinor")::text
        from app.purchase_order_lines pol
        where pol."purchaseOrderId" = po."id" and pol."businessId" = po."businessId"
      ), '0') as "totalMinor"
    from app.purchase_orders po
    left join app.supplier_accounts s on s."id" = po."supplierAccountId" and s."businessId" = po."businessId"
    left join app.parties sp on sp."id" = s."partyId" and sp."businessId" = s."businessId"
    left join app.stores st on st."id" = po."storeId" and st."businessId" = po."businessId"
    where po."id" = ${orderId}::uuid and po."businessId" = ${businessId}::uuid
    limit 1
  `.execute(c.transaction);
  return result.rows[0];
}

export async function listPurchaseOrderLines(c: DatabaseContext, businessId: string, orderId: string): Promise<PurchaseOrderLineRow[]> {
  const result = await sql<PurchaseOrderLineRow>`
    select
      pol."id",
      pol."businessId",
      pol."purchaseOrderId",
      pol."inventoryItemId",
      pol."quantityOrdered"::text as "quantityOrdered",
      pol."quantityReceived"::text as "quantityReceived",
      pol."unitCostMinor"::text as "unitCostMinor",
      pol."createdAt"::text as "createdAt",
      ii."name" as "itemName",
      ii."sku" as "sku"
    from app.purchase_order_lines pol
    left join app.inventory_items ii on ii."id" = pol."inventoryItemId" and ii."businessId" = pol."businessId"
    where pol."purchaseOrderId" = ${orderId}::uuid and pol."businessId" = ${businessId}::uuid
    order by pol."createdAt" asc
  `.execute(c.transaction);
  return result.rows;
}

export async function listPurchaseOrderReceipts(c: DatabaseContext, businessId: string, orderId: string): Promise<GoodsReceiptRow[]> {
  const receipts = (await sql<GoodsReceiptRow>`
    select
      "id",
      "businessId",
      "purchaseOrderId",
      "inventoryLocationId",
      "status",
      "receivedAt"::text as "receivedAt",
      "receivedBy",
      "idempotencyKey",
      "createdAt"::text as "createdAt"
    from app.goods_receipts
    where "purchaseOrderId" = ${orderId}::uuid and "businessId" = ${businessId}::uuid
    order by "receivedAt" desc
  `.execute(c.transaction)).rows;

  for (const receipt of receipts) {
    const lines = await listReceiptLines(c, businessId, receipt.id);
    (receipt as any).lines = lines;
  }

  return receipts;
}

export async function listReceiptLines(c: DatabaseContext, businessId: string, receiptId: string): Promise<GoodsReceiptLineRow[]> {
  return (await sql<GoodsReceiptLineRow>`
    select
      grl."id",
      grl."businessId",
      grl."receiptId",
      grl."purchaseOrderLineId",
      grl."inventoryItemId",
      grl."quantityReceived"::text as "quantityReceived",
      grl."quantityRejected"::text as "quantityRejected",
      grl."unitCostMinor"::text as "unitCostMinor",
      grl."createdAt"::text as "createdAt",
      ii."name" as "itemName"
    from app.goods_receipt_lines grl
    left join app.inventory_items ii on ii."id" = grl."inventoryItemId" and ii."businessId" = grl."businessId"
    where grl."receiptId" = ${receiptId}::uuid and grl."businessId" = ${businessId}::uuid
    order by grl."createdAt" asc
  `.execute(c.transaction)).rows;
}

export async function updatePurchaseOrder(c: DatabaseContext, businessId: string, orderId: string, input: UpdatePurchaseOrderInput): Promise<PurchaseOrderRow | undefined> {
  const updates: RawBuilder<unknown>[] = [];
  if (input.status !== undefined) updates.push(sql`"status" = ${input.status}`);
  if (input.expectedAt !== undefined) updates.push(sql`"expectedAt" = ${input.expectedAt}::timestamptz`);
  if (input.notes !== undefined) updates.push(sql`"notes" = ${input.notes}`);

  if (updates.length === 0) return findPurchaseOrderById(c, businessId, orderId);

  await sql`
    update app.purchase_orders
    set ${sql.join(updates, sql`, `)}
    where "id" = ${orderId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(c.transaction);

  return findPurchaseOrderById(c, businessId, orderId);
}

async function resolveInventoryLocationId(c: DatabaseContext, businessId: string, locationId: string): Promise<string> {
  const existingInvLoc = (await sql<{ id: string }>`
    select "id" from app.inventory_locations
    where "businessId" = ${businessId}::uuid and "id" = ${locationId}::uuid
    limit 1
  `.execute(c.transaction)).rows[0];
  if (existingInvLoc) return existingInvLoc.id;

  const existingByLoc = (await sql<{ id: string }>`
    select "id" from app.inventory_locations
    where "businessId" = ${businessId}::uuid and "locationId" = ${locationId}::uuid
    limit 1
  `.execute(c.transaction)).rows[0];
  if (existingByLoc) return existingByLoc.id;

  const branchLoc = (await sql<{ id: string; name: string }>`
    select "id", "name" from app.locations
    where "businessId" = ${businessId}::uuid and "id" = ${locationId}::uuid
    limit 1
  `.execute(c.transaction)).rows[0];

  if (branchLoc) {
    const created = (await sql<{ id: string }>`
      insert into app.inventory_locations ("businessId", "locationId", "name")
      values (${businessId}::uuid, ${branchLoc.id}::uuid, ${branchLoc.name})
      on conflict ("businessId", "locationId") do update set "name" = excluded."name"
      returning "id"
    `.execute(c.transaction)).rows[0]!;
    return created.id;
  }

  const fallback = (await sql<{ id: string }>`
    select "id" from app.inventory_locations
    where "businessId" = ${businessId}::uuid
    limit 1
  `.execute(c.transaction)).rows[0];
  if (fallback) return fallback.id;

  return locationId;
}

export async function createReceipt(c: DatabaseContext, businessId: string, userId: string, requestId: string, input: GoodsReceiptInput) {
  const inventoryLocationId = await resolveInventoryLocationId(c, businessId, input.inventoryLocationId);
  const receipt = (await sql<{ id: string }>`
    insert into app.goods_receipts ("businessId", "purchaseOrderId", "inventoryLocationId", "receivedBy", "idempotencyKey")
    values (${businessId}::uuid, ${input.purchaseOrderId}::uuid, ${inventoryLocationId}::uuid, ${userId}::uuid, ${input.idempotencyKey})
    on conflict ("businessId", "idempotencyKey") do nothing
    returning "id"
  `.execute(c.transaction)).rows[0];

  if (!receipt) return null;

  for (const line of input.lines) {
    await sql`
      insert into app.goods_receipt_lines ("businessId", "receiptId", "purchaseOrderLineId", "inventoryItemId", "quantityReceived", "quantityRejected", "unitCostMinor")
      values (${businessId}::uuid, ${receipt.id}::uuid, ${line.purchaseOrderLineId}::uuid, ${line.inventoryItemId}::uuid, ${line.quantityReceived}, ${line.quantityRejected ?? 0}, ${line.unitCostMinor})
    `.execute(c.transaction);

    await sql`
      update app.purchase_order_lines
      set "quantityReceived" = "quantityReceived" + ${line.quantityReceived}
      where "id" = ${line.purchaseOrderLineId}::uuid and "businessId" = ${businessId}::uuid
    `.execute(c.transaction);

    await sql`
      insert into app.stock_transactions ("businessId", "type", "reason", "actorUserId", "requestId", "idempotencyKey")
      values (${businessId}::uuid, 'receipt', 'Goods receipt', ${userId}::uuid, ${requestId}, ${`${input.idempotencyKey}:${line.purchaseOrderLineId}`})
    `.execute(c.transaction);

    await sql`
      insert into app.stock_balances ("businessId", "inventoryItemId", "inventoryLocationId", "onHand")
      values (${businessId}::uuid, ${line.inventoryItemId}::uuid, ${inventoryLocationId}::uuid, ${line.quantityReceived})
      on conflict ("businessId", "inventoryItemId", "inventoryLocationId")
      do update set "onHand" = app.stock_balances."onHand" + excluded."onHand"
    `.execute(c.transaction);
  }

  // Update purchase order status based on remaining unfulfilled quantities
  const progress = (await sql<{ unfulfilled: string; partial: string }>`
    select
      count(*) filter (where "quantityReceived" < "quantityOrdered")::text as "unfulfilled",
      count(*) filter (where "quantityReceived" > 0)::text as "partial"
    from app.purchase_order_lines
    where "purchaseOrderId" = ${input.purchaseOrderId}::uuid and "businessId" = ${businessId}::uuid
  `.execute(c.transaction)).rows[0];

  if (progress) {
    const unfulfilledCount = Number(progress.unfulfilled);
    const partialCount = Number(progress.partial);
    if (unfulfilledCount === 0) {
      await sql`
        update app.purchase_orders
        set "status" = 'received'
        where "id" = ${input.purchaseOrderId}::uuid and "businessId" = ${businessId}::uuid
      `.execute(c.transaction);
    } else if (partialCount > 0) {
      await sql`
        update app.purchase_orders
        set "status" = 'partially_received'
        where "id" = ${input.purchaseOrderId}::uuid and "businessId" = ${businessId}::uuid and "status" in ('draft', 'sent')
      `.execute(c.transaction);
    }
  }

  return receipt;
}

export async function listGoodsReceipts(c: DatabaseContext, businessId: string, f: ListGoodsReceiptsFilter): Promise<{ receipts: GoodsReceiptRow[]; total: number }> {
  const clauses: RawBuilder<unknown>[] = [sql`gr."businessId" = ${businessId}::uuid`];
  if (f.purchaseOrderId) clauses.push(sql`gr."purchaseOrderId" = ${f.purchaseOrderId}::uuid`);
  if (f.inventoryLocationId) clauses.push(sql`gr."inventoryLocationId" = ${f.inventoryLocationId}::uuid`);

  const whereClause = sql.join(clauses, sql` and `);
  const page = f.page ?? 1;
  const pageSize = f.pageSize ?? 50;
  const offset = (page - 1) * pageSize;

  const countResult = await sql<{ count: string }>`
    select count(*)::text as "count"
    from app.goods_receipts gr
    where ${whereClause}
  `.execute(c.transaction);
  const total = Number(countResult.rows[0]?.count ?? 0);

  const receipts = (await sql<GoodsReceiptRow>`
    select
      gr."id",
      gr."businessId",
      gr."purchaseOrderId",
      gr."inventoryLocationId",
      gr."status",
      gr."receivedAt"::text as "receivedAt",
      gr."receivedBy",
      gr."idempotencyKey",
      gr."createdAt"::text as "createdAt"
    from app.goods_receipts gr
    where ${whereClause}
    order by gr."receivedAt" desc
    limit ${pageSize} offset ${offset}
  `.execute(c.transaction)).rows;

  for (const receipt of receipts) {
    const lines = await listReceiptLines(c, businessId, receipt.id);
    (receipt as any).lines = lines;
  }

  return { receipts, total };
}
