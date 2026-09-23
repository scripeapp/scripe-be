import type { DatabaseContext } from "../../db/database-context.js";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { notFoundError, validationError } from "../../shared/errors.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import { postJournalEntry } from "../accounting/accounting.service.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./inventory.repository.js";
import type { CreateStockCountInput, CreateStockTransferInput, InventoryItem, InventoryItemInput, InventoryLocation, InventoryLocationInput, InventoryOperation, MovementInput, ReceiveStockTransferInput, Reservation, ReservationInput, SetStockCountLinesInput, StockBalance, StockCount, StockCountLine, StockMovement, StockTransfer, StockTransferLine } from "./inventory.types.js";
export class InventoryService {
  constructor(private readonly database: Database) {}
  listBalances(o: InventoryOperation, f: { inventoryItemId?: string; inventoryLocationId?: string }): Promise<StockBalance[]> { return this.run(o, (c) => repo.listBalances(c, o.businessId, f)); }
  listItems(o: InventoryOperation, f: { status?: string; search?: string }): Promise<InventoryItem[]> { return this.run(o, (c) => repo.listItems(c, o.businessId, f)); }
  getItem(o: InventoryOperation, itemId: string): Promise<InventoryItem> { return this.run(o, async (c) => { const row = await repo.findItem(c, o.businessId, itemId); if (!row) throw notFoundError("Inventory item not found"); return row; }); }
  listLocations(o: InventoryOperation): Promise<InventoryLocation[]> { return this.run(o, (c) => repo.listLocations(c, o.businessId)); }
  listMovements(o: InventoryOperation, f: { inventoryItemId?: string; inventoryLocationId?: string; limit: number }) { return this.run(o, (c) => repo.listMovements(c, o.businessId, f)); }
  createItem(o: InventoryOperation, input: InventoryItemInput): Promise<InventoryItem> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createItem(c, o.businessId, input); }); }
  createLocation(o: InventoryOperation, input: InventoryLocationInput): Promise<InventoryLocation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createLocation(c, o.businessId, input); }); }
  postMovement(o: InventoryOperation, input: MovementInput): Promise<StockMovement> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      return this.postMovementWithJournal(c, o, input);
    });
  }
  reserve(o: InventoryOperation, input: ReservationInput): Promise<Reservation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.reserve"); return repo.createReservation(c, o.businessId, input); }); }
  release(o: InventoryOperation, id: string): Promise<Reservation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.reserve"); const row = await repo.releaseReservation(c, o.businessId, id); if (!row) throw notFoundError("Active reservation not found"); return row; }); }

  // ---- Stock transfers ----
  listTransfers(o: InventoryOperation, f: { status?: string }): Promise<StockTransfer[]> { return this.run(o, (c) => repo.listTransfers(c, o.businessId, f)); }
  async getTransfer(o: InventoryOperation, transferId: string): Promise<StockTransfer & { lines: StockTransferLine[] }> {
    return this.run(o, async (c) => {
      const transfer = await repo.findTransfer(c, o.businessId, transferId);
      if (!transfer) throw notFoundError("Transfer not found");
      return { ...transfer, lines: await repo.listTransferLines(c, o.businessId, transferId) };
    });
  }
  createTransfer(o: InventoryOperation, input: CreateStockTransferInput): Promise<StockTransfer> {
    return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createTransfer(c, o.businessId, o.userId, input); });
  }
  /** Posts a transfer_out movement per line at the source location — stock leaves as soon as it's sent, before the receiving side confirms anything. */
  sendTransfer(o: InventoryOperation, transferId: string): Promise<StockTransfer> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      const transfer = await repo.findTransfer(c, o.businessId, transferId);
      if (!transfer) throw notFoundError("Transfer not found");
      if (transfer.status !== "draft") throw validationError("Only a draft transfer can be sent");
      const lines = await repo.listTransferLines(c, o.businessId, transferId);
      if (lines.length === 0) throw validationError("Transfer has no lines");
      for (const line of lines) {
        await this.postMovementWithJournal(c, o, {
          inventoryItemId: line.inventoryItemId,
          inventoryLocationId: transfer.fromInventoryLocationId,
          quantity: -Math.abs(Number(line.quantity)),
          type: "transfer_out",
          reason: `Transfer ${transfer.reference}`,
          idempotencyKey: `transfer:${transferId}:send:${line.id}`,
          unitCostMinor: line.unitCostMinor ? Number(line.unitCostMinor) : null,
        });
      }
      const updated = await repo.markTransferSent(c, o.businessId, transferId);
      if (!updated) throw validationError("Only a draft transfer can be sent");
      return updated;
    });
  }
  /**
   * Posts a transfer_in movement per line at the destination, for the
   * quantity actually received — which the receiving side may report as
   * less than what was sent (loss/damage/miscount in transit). The
   * difference is simply not received; nothing reconciles it automatically.
   */
  receiveTransfer(o: InventoryOperation, transferId: string, input: ReceiveStockTransferInput): Promise<StockTransfer> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      const transfer = await repo.findTransfer(c, o.businessId, transferId);
      if (!transfer) throw notFoundError("Transfer not found");
      if (transfer.status !== "sent") throw validationError("Only a sent transfer can be received");
      const lines = await repo.listTransferLines(c, o.businessId, transferId);
      const byId = new Map(lines.map((l) => [l.id, l]));
      for (const receipt of input.lines) {
        const line = byId.get(receipt.lineId);
        if (!line) throw validationError(`Transfer has no line ${receipt.lineId}`);
        if (receipt.quantityReceived <= 0) continue;
        await this.postMovementWithJournal(c, o, {
          inventoryItemId: line.inventoryItemId,
          inventoryLocationId: transfer.toInventoryLocationId,
          quantity: Math.abs(receipt.quantityReceived),
          type: "transfer_in",
          reason: `Transfer ${transfer.reference}`,
          idempotencyKey: `transfer:${transferId}:receive:${line.id}`,
          unitCostMinor: line.unitCostMinor ? Number(line.unitCostMinor) : null,
        });
      }
      const updated = await repo.markTransferReceived(c, o.businessId, transferId, input.lines);
      if (!updated) throw validationError("Only a sent transfer can be received");
      return updated;
    });
  }
  cancelTransfer(o: InventoryOperation, transferId: string): Promise<void> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      if (!(await repo.cancelTransfer(c, o.businessId, transferId))) throw validationError("Only a draft transfer can be cancelled");
    });
  }

  // ---- Stock counts ----
  listCounts(o: InventoryOperation, f: { status?: string }): Promise<StockCount[]> { return this.run(o, (c) => repo.listCounts(c, o.businessId, f)); }
  async getCount(o: InventoryOperation, countId: string): Promise<StockCount & { lines: StockCountLine[] }> {
    return this.run(o, async (c) => {
      const count = await repo.findCount(c, o.businessId, countId);
      if (!count) throw notFoundError("Count not found");
      return { ...count, lines: await repo.listCountLines(c, o.businessId, countId) };
    });
  }
  createCount(o: InventoryOperation, input: CreateStockCountInput): Promise<StockCount> {
    return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createCount(c, o.businessId, o.userId, input); });
  }
  setCountLines(o: InventoryOperation, countId: string, input: SetStockCountLinesInput): Promise<StockCountLine[]> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      const count = await repo.findCount(c, o.businessId, countId);
      if (!count) throw notFoundError("Count not found");
      if (count.status !== "draft") throw validationError("Only a draft count can be edited");
      await repo.setCountLines(c, o.businessId, countId, count.inventoryLocationId, input.lines);
      return repo.listCountLines(c, o.businessId, countId);
    });
  }
  /** Posts one adjustment movement per line for its variance (counted − system) — a zero-variance line posts nothing, there's nothing to correct. */
  applyCount(o: InventoryOperation, countId: string): Promise<StockCount> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      const count = await repo.findCount(c, o.businessId, countId);
      if (!count) throw notFoundError("Count not found");
      if (count.status !== "draft") throw validationError("Only a draft count can be applied");
      const lines = await repo.listCountLines(c, o.businessId, countId);
      if (lines.length === 0) throw validationError("Count has no lines");
      for (const line of lines) {
        const variance = Number(line.countedQuantity) - Number(line.systemQuantity);
        if (variance === 0) continue;
        await this.postMovementWithJournal(c, o, {
          inventoryItemId: line.inventoryItemId,
          inventoryLocationId: count.inventoryLocationId,
          quantity: variance,
          type: "count",
          reason: `Stock count ${count.reference}`,
          idempotencyKey: `count:${countId}:apply:${line.id}`,
        });
      }
      const updated = await repo.markCountApplied(c, o.businessId, countId);
      if (!updated) throw validationError("Only a draft count can be applied");
      return updated;
    });
  }
  cancelCount(o: InventoryOperation, countId: string): Promise<void> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
      if (!(await repo.cancelCount(c, o.businessId, countId))) throw validationError("Only a draft count can be cancelled");
    });
  }

  /** Shared by direct movement posting and the transfer/count workflows — every path that moves stock needs the same idempotent-post + waste-journal behavior. */
  private async postMovementWithJournal(c: DatabaseContext, o: InventoryOperation, input: MovementInput): Promise<StockMovement> {
    const row = await repo.postMovement(c, o.businessId, o.userId, input, o.requestId);
    if (!row) throw new Error("Movement idempotency key already used");
    // Only "waste" carries a reliable unit cost at this call site (unlike
    // "sale", which has no COGS posting in this pass - see migration
    // 0042's header comment) - Dr the expense, Cr the inventory asset it
    // came out of.
    if (input.type === "waste" && input.unitCostMinor) {
      const amountMinor = BigInt(Math.round(Math.abs(input.quantity) * input.unitCostMinor));
      if (amountMinor > 0n) {
        await postJournalEntry(c, o.businessId, o.userId, {
          description: "Inventory waste recorded",
          sourceType: "stock_movement",
          sourceId: row.id,
          lines: [
            { accountCode: LEDGER_ACCOUNT_CODES.WASTE_EXPENSE, direction: "debit", amountMinor, assetCode: "NGN" },
            { accountCode: LEDGER_ACCOUNT_CODES.INVENTORY, direction: "credit", amountMinor, assetCode: "NGN" },
          ],
        });
      }
    }
    return row;
  }
  private async require(c: Parameters<typeof repo.listBalances>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(o: InventoryOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), work); } catch (e) { if (e instanceof DatabaseError || (e && typeof e === "object" && "code" in e && "statusCode" in e)) throw e; throw normalizeDatabaseError(e); } }
}
