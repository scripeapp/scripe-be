import { sql, type RawBuilder } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { CreateStockCountInput, CreateStockTransferInput, InventoryItem, InventoryItemInput, InventoryLocation, InventoryLocationInput, MovementInput, ReceiveStockTransferLineInput, Reservation, ReservationInput, StockBalance, StockCount, StockCountLine, StockCountLineInput, StockMovement, StockTransfer, StockTransferLine } from "./inventory.types.js";
export async function listBalances(c: DatabaseContext, businessId: string, f: { inventoryItemId?: string; inventoryLocationId?: string }): Promise<StockBalance[]> { const clauses: RawBuilder<unknown>[] = [sql`b."businessId"=${businessId}::uuid`]; if (f.inventoryItemId) clauses.push(sql`b."inventoryItemId"=${f.inventoryItemId}::uuid`); if (f.inventoryLocationId) clauses.push(sql`b."inventoryLocationId"=${f.inventoryLocationId}::uuid`); return (await sql<StockBalance>`select b.*, (b."onHand" - b."reserved")::text as "available" from app.stock_balances b where ${sql.join(clauses, sql` and `)} order by b."updatedAt" desc`.execute(c.transaction)).rows; }
export async function listItems(c: DatabaseContext, businessId: string, f: { status?: string; search?: string }): Promise<InventoryItem[]> { const clauses: RawBuilder<unknown>[] = [sql`"businessId"=${businessId}::uuid`]; if (f.status) clauses.push(sql`"status"=${f.status}`); else clauses.push(sql`"status" <> 'archived'`); if (f.search) clauses.push(sql`("name" ilike ${`%${f.search}%`} or "sku" ilike ${`%${f.search}%`})`); return (await sql<InventoryItem>`select * from app.inventory_items where ${sql.join(clauses, sql` and `)} order by "name"`.execute(c.transaction)).rows; }
export async function findItem(c: DatabaseContext, businessId: string, itemId: string): Promise<InventoryItem | undefined> { return (await sql<InventoryItem>`select * from app.inventory_items where "businessId"=${businessId}::uuid and "id"=${itemId}::uuid limit 1`.execute(c.transaction)).rows[0]; }
export async function listLocations(c: DatabaseContext, businessId: string): Promise<InventoryLocation[]> { return (await sql<InventoryLocation>`select * from app.inventory_locations where "businessId"=${businessId}::uuid and "status" <> 'archived' order by "name"`.execute(c.transaction)).rows; }
export async function listMovements(c: DatabaseContext, businessId: string, f: { inventoryItemId?: string; inventoryLocationId?: string; limit: number }): Promise<(StockMovement & { type: string; reason: string })[]> { const clauses: RawBuilder<unknown>[] = [sql`m."businessId"=${businessId}::uuid`]; if (f.inventoryItemId) clauses.push(sql`m."inventoryItemId"=${f.inventoryItemId}::uuid`); if (f.inventoryLocationId) clauses.push(sql`m."inventoryLocationId"=${f.inventoryLocationId}::uuid`); return (await sql<StockMovement & { type: string; reason: string }>`select m.*, t."type", t."reason" from app.stock_movements m join app.stock_transactions t on t."id"=m."transactionId" where ${sql.join(clauses, sql` and `)} order by m."createdAt" desc limit ${f.limit}`.execute(c.transaction)).rows; }
export async function createItem(c: DatabaseContext, businessId: string, input: InventoryItemInput): Promise<InventoryItem> { return (await sql<InventoryItem>`insert into app.inventory_items ("businessId","variantId","name","sku","trackingMode") values (${businessId}::uuid,${input.variantId ?? null}::uuid,${input.name},${input.sku ?? null},${input.trackingMode ?? 'quantity'}) returning *`.execute(c.transaction)).rows[0]!; }
/** Idempotent — this is the "ensure an inventory-tracked wrapper exists for this branch" call, so a caller never has to check first. */
export async function createLocation(c: DatabaseContext, businessId: string, input: InventoryLocationInput): Promise<InventoryLocation> {
  const existing = (await sql<InventoryLocation>`select * from app.inventory_locations where "businessId"=${businessId}::uuid and "locationId"=${input.locationId}::uuid limit 1`.execute(c.transaction)).rows[0];
  if (existing) return existing;
  return (await sql<InventoryLocation>`insert into app.inventory_locations ("businessId","locationId","name") values (${businessId}::uuid,${input.locationId}::uuid,${input.name}) on conflict ("businessId","locationId") do update set "name"=excluded."name" returning *`.execute(c.transaction)).rows[0]!;
}
export async function postMovement(c: DatabaseContext, businessId: string, userId: string, input: MovementInput, requestId: string): Promise<StockMovement | null> { const tx = (await sql<{ id: string }>`insert into app.stock_transactions ("businessId","type","reason","actorUserId","requestId","idempotencyKey") values (${businessId}::uuid,${input.type},${input.reason},${userId}::uuid,${requestId},${input.idempotencyKey}) on conflict ("businessId","idempotencyKey") do nothing returning "id"`.execute(c.transaction)).rows[0]; if (!tx) return null; const balance = input.quantity > 0 ? (await sql<{ id: string }>`insert into app.stock_balances ("businessId","inventoryItemId","inventoryLocationId","onHand") values (${businessId}::uuid,${input.inventoryItemId}::uuid,${input.inventoryLocationId}::uuid,${input.quantity}) on conflict ("businessId","inventoryItemId","inventoryLocationId") do update set "onHand"=app.stock_balances."onHand" + excluded."onHand" returning "id"`.execute(c.transaction)).rows[0] : (await sql<{ id: string }>`update app.stock_balances set "onHand"=app.stock_balances."onHand" + ${input.quantity} where "businessId"=${businessId}::uuid and "inventoryItemId"=${input.inventoryItemId}::uuid and "inventoryLocationId"=${input.inventoryLocationId}::uuid and app.stock_balances."onHand" + ${input.quantity} >= app.stock_balances."reserved" returning "id"`.execute(c.transaction)).rows[0]; if (!balance) throw new Error("Insufficient available stock"); return (await sql<StockMovement>`insert into app.stock_movements ("businessId","transactionId","inventoryItemId","inventoryLocationId","quantity","unitCostMinor") values (${businessId}::uuid,${tx.id}::uuid,${input.inventoryItemId}::uuid,${input.inventoryLocationId}::uuid,${input.quantity},${input.unitCostMinor ?? null}) returning *`.execute(c.transaction)).rows[0]!; }
export async function createReservation(c: DatabaseContext, businessId: string, input: ReservationInput): Promise<Reservation> { const balance = (await sql<{ id: string; onHand: string; reserved: string }>`select "id","onHand","reserved" from app.stock_balances where "businessId"=${businessId}::uuid and "inventoryItemId"=${input.inventoryItemId}::uuid and "inventoryLocationId"=${input.inventoryLocationId}::uuid for update`.execute(c.transaction)).rows[0]; if (!balance || Number(balance.onHand) - Number(balance.reserved) < input.quantity) throw new Error("Insufficient available stock"); const row = (await sql<Reservation>`insert into app.stock_reservations ("businessId","inventoryItemId","inventoryLocationId","quantity","referenceType","referenceId","expiresAt") values (${businessId}::uuid,${input.inventoryItemId}::uuid,${input.inventoryLocationId}::uuid,${input.quantity},${input.referenceType},${input.referenceId},${input.expiresAt ?? null}::timestamptz) returning *`.execute(c.transaction)).rows[0]!; await sql`update app.stock_balances set "reserved"="reserved"+${input.quantity} where "id"=${balance.id}::uuid`.execute(c.transaction); return row; }
export async function releaseReservation(c: DatabaseContext, businessId: string, reservationId: string): Promise<Reservation | undefined> { const row = (await sql<Reservation>`update app.stock_reservations set "status"='released',"releasedAt"=now() where "businessId"=${businessId}::uuid and "id"=${reservationId}::uuid and "status"='active' returning *`.execute(c.transaction)).rows[0]; if (!row) return undefined; await sql`update app.stock_balances set "reserved"="reserved"-${row.quantity} where "businessId"=${businessId}::uuid and "inventoryItemId"=${row.inventoryItemId}::uuid and "inventoryLocationId"=${row.inventoryLocationId}::uuid`.execute(c.transaction); return row; }

/** Idempotent upsert keyed on (businessId, variantId) — called from the products domain whenever a trackable variant is created/updated, so an inventory item always exists before any stock action touches it. */
export async function ensureItemForVariant(c: DatabaseContext, businessId: string, variantId: string, name: string, sku: string | null): Promise<InventoryItem> {
  return (await sql<InventoryItem>`
    insert into app.inventory_items ("businessId","variantId","name","sku")
    values (${businessId}::uuid,${variantId}::uuid,${name},${sku})
    on conflict ("businessId","variantId") where "variantId" is not null
    do update set "name"=excluded."name", "sku"=coalesce(excluded."sku", app.inventory_items."sku")
    returning *
  `.execute(c.transaction)).rows[0]!;
}

/** Idempotent — resolves a real branch (app.locations) id to its inventory-tracking wrapper, creating one on first use. */
export async function ensureLocation(c: DatabaseContext, businessId: string, locationId: string): Promise<InventoryLocation> {
  const location = (await sql<{ name: string }>`select "name" from app.locations where "businessId"=${businessId}::uuid and "id"=${locationId}::uuid limit 1`.execute(c.transaction)).rows[0];
  if (!location) throw new Error("Location not found");
  return createLocation(c, businessId, { locationId, name: location.name });
}

// ---- Stock transfers ----

export async function createTransfer(c: DatabaseContext, businessId: string, userId: string, input: CreateStockTransferInput): Promise<StockTransfer> {
  const from = await ensureLocation(c, businessId, input.fromLocationId);
  const to = await ensureLocation(c, businessId, input.toLocationId);
  const transfer = (await sql<StockTransfer>`
    insert into app.stock_transfers ("businessId","reference","fromInventoryLocationId","toInventoryLocationId","notes","createdBy")
    values (${businessId}::uuid,${input.reference},${from.id}::uuid,${to.id}::uuid,${input.notes ?? ''},${userId}::uuid)
    returning *
  `.execute(c.transaction)).rows[0]!;
  for (const line of input.lines) {
    await sql`insert into app.stock_transfer_lines ("businessId","transferId","inventoryItemId","quantity","unitCostMinor") values (${businessId}::uuid,${transfer.id}::uuid,${line.inventoryItemId}::uuid,${line.quantity},${line.unitCostMinor ?? null})`.execute(c.transaction);
  }
  return transfer;
}
export async function listTransfers(c: DatabaseContext, businessId: string, f: { status?: string }): Promise<(StockTransfer & { itemCount: number; totalValueMinor: string })[]> {
  const clauses: RawBuilder<unknown>[] = [sql`t."businessId"=${businessId}::uuid`]; if (f.status) clauses.push(sql`t."status"=${f.status}`);
  return (await sql<StockTransfer & { itemCount: number; totalValueMinor: string }>`
    select t.*, coalesce(l."itemCount", 0)::int as "itemCount", coalesce(l."totalValueMinor", 0)::text as "totalValueMinor"
    from app.stock_transfers t
    left join lateral (
      select count(*) as "itemCount", sum(coalesce("unitCostMinor", 0) * "quantity") as "totalValueMinor"
      from app.stock_transfer_lines where "transferId" = t."id"
    ) l on true
    where ${sql.join(clauses, sql` and `)}
    order by t."createdAt" desc
  `.execute(c.transaction)).rows;
}
export async function findTransfer(c: DatabaseContext, businessId: string, transferId: string): Promise<StockTransfer | undefined> { return (await sql<StockTransfer>`select * from app.stock_transfers where "businessId"=${businessId}::uuid and "id"=${transferId}::uuid limit 1`.execute(c.transaction)).rows[0]; }
export async function listTransferLines(c: DatabaseContext, businessId: string, transferId: string): Promise<StockTransferLine[]> { return (await sql<StockTransferLine>`select * from app.stock_transfer_lines where "businessId"=${businessId}::uuid and "transferId"=${transferId}::uuid order by "createdAt"`.execute(c.transaction)).rows; }
export async function markTransferSent(c: DatabaseContext, businessId: string, transferId: string): Promise<StockTransfer | undefined> { return (await sql<StockTransfer>`update app.stock_transfers set "status"='sent',"sentAt"=now() where "businessId"=${businessId}::uuid and "id"=${transferId}::uuid and "status"='draft' returning *`.execute(c.transaction)).rows[0]; }
export async function markTransferReceived(c: DatabaseContext, businessId: string, transferId: string, lines: readonly ReceiveStockTransferLineInput[]): Promise<StockTransfer | undefined> {
  for (const line of lines) {
    await sql`update app.stock_transfer_lines set "quantityReceived"=${line.quantityReceived} where "businessId"=${businessId}::uuid and "id"=${line.lineId}::uuid and "transferId"=${transferId}::uuid`.execute(c.transaction);
  }
  return (await sql<StockTransfer>`update app.stock_transfers set "status"='received',"receivedAt"=now() where "businessId"=${businessId}::uuid and "id"=${transferId}::uuid and "status"='sent' returning *`.execute(c.transaction)).rows[0];
}
/** Cancellable from draft (nothing posted yet) or sent (stock already left the source — the caller reverses that separately, before this flips the status). */
export async function cancelTransfer(c: DatabaseContext, businessId: string, transferId: string): Promise<StockTransfer | undefined> { return (await sql<StockTransfer>`update app.stock_transfers set "status"='cancelled' where "businessId"=${businessId}::uuid and "id"=${transferId}::uuid and "status" in ('draft','sent') returning *`.execute(c.transaction)).rows[0]; }

// ---- Stock counts ----

async function currentOnHand(c: DatabaseContext, businessId: string, inventoryItemId: string, inventoryLocationId: string): Promise<string> {
  const row = (await sql<{ onHand: string }>`select "onHand" from app.stock_balances where "businessId"=${businessId}::uuid and "inventoryItemId"=${inventoryItemId}::uuid and "inventoryLocationId"=${inventoryLocationId}::uuid limit 1`.execute(c.transaction)).rows[0];
  return row?.onHand ?? "0";
}

export async function createCount(c: DatabaseContext, businessId: string, userId: string, input: CreateStockCountInput): Promise<StockCount> {
  const location = await ensureLocation(c, businessId, input.locationId);
  const count = (await sql<StockCount>`
    insert into app.stock_counts ("businessId","reference","inventoryLocationId","scope","countDate","notes","createdBy")
    values (${businessId}::uuid,${input.reference},${location.id}::uuid,${input.scope ?? 'selected'},${input.countDate ?? new Date().toISOString().slice(0, 10)}::date,${input.notes ?? ''},${userId}::uuid)
    returning *
  `.execute(c.transaction)).rows[0]!;
  if (input.lines?.length) await setCountLines(c, businessId, count.id, location.id, input.lines);
  return count;
}
export async function listCounts(c: DatabaseContext, businessId: string, f: { status?: string }): Promise<(StockCount & { itemCount: number; totalVariance: string })[]> {
  const clauses: RawBuilder<unknown>[] = [sql`c2."businessId"=${businessId}::uuid`]; if (f.status) clauses.push(sql`c2."status"=${f.status}`);
  return (await sql<StockCount & { itemCount: number; totalVariance: string }>`
    select c2.*, coalesce(l."itemCount", 0)::int as "itemCount", coalesce(l."totalVariance", 0)::text as "totalVariance"
    from app.stock_counts c2
    left join lateral (
      select count(*) as "itemCount", sum("countedQuantity" - "systemQuantity") as "totalVariance"
      from app.stock_count_lines where "countId" = c2."id"
    ) l on true
    where ${sql.join(clauses, sql` and `)}
    order by c2."createdAt" desc
  `.execute(c.transaction)).rows;
}
export async function findCount(c: DatabaseContext, businessId: string, countId: string): Promise<StockCount | undefined> { return (await sql<StockCount>`select * from app.stock_counts where "businessId"=${businessId}::uuid and "id"=${countId}::uuid limit 1`.execute(c.transaction)).rows[0]; }
export async function listCountLines(c: DatabaseContext, businessId: string, countId: string): Promise<StockCountLine[]> { return (await sql<StockCountLine>`select * from app.stock_count_lines where "businessId"=${businessId}::uuid and "countId"=${countId}::uuid order by "createdAt"`.execute(c.transaction)).rows; }
/** Replaces every line — the count's own reviewed set at any point is exactly what was last saved, not an accumulation. systemQuantity is (re-)snapshotted from the live balance whenever a line is (re-)set, same as adding it fresh. */
export async function setCountLines(c: DatabaseContext, businessId: string, countId: string, inventoryLocationId: string, lines: readonly StockCountLineInput[]): Promise<void> {
  await sql`delete from app.stock_count_lines where "businessId"=${businessId}::uuid and "countId"=${countId}::uuid`.execute(c.transaction);
  for (const line of lines) {
    const systemQuantity = await currentOnHand(c, businessId, line.inventoryItemId, inventoryLocationId);
    await sql`insert into app.stock_count_lines ("businessId","countId","inventoryItemId","systemQuantity","countedQuantity") values (${businessId}::uuid,${countId}::uuid,${line.inventoryItemId}::uuid,${systemQuantity}::numeric,${line.countedQuantity})`.execute(c.transaction);
  }
}
export async function markCountApplied(c: DatabaseContext, businessId: string, countId: string): Promise<StockCount | undefined> { return (await sql<StockCount>`update app.stock_counts set "status"='applied',"appliedAt"=now() where "businessId"=${businessId}::uuid and "id"=${countId}::uuid and "status"='draft' returning *`.execute(c.transaction)).rows[0]; }
export async function cancelCount(c: DatabaseContext, businessId: string, countId: string): Promise<StockCount | undefined> { return (await sql<StockCount>`update app.stock_counts set "status"='cancelled' where "businessId"=${businessId}::uuid and "id"=${countId}::uuid and "status"='draft' returning *`.execute(c.transaction)).rows[0]; }
