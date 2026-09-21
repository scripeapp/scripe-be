import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { notFoundError } from "../../shared/errors.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import { postJournalEntry } from "../accounting/accounting.service.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./inventory.repository.js";
import type { InventoryItem, InventoryItemInput, InventoryLocation, InventoryLocationInput, InventoryOperation, MovementInput, Reservation, ReservationInput, StockBalance, StockMovement } from "./inventory.types.js";
export class InventoryService {
  constructor(private readonly database: Database) {}
  listBalances(o: InventoryOperation, f: { inventoryItemId?: string; inventoryLocationId?: string }): Promise<StockBalance[]> { return this.run(o, (c) => repo.listBalances(c, o.businessId, f)); }
  createItem(o: InventoryOperation, input: InventoryItemInput): Promise<InventoryItem> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createItem(c, o.businessId, input); }); }
  createLocation(o: InventoryOperation, input: InventoryLocationInput): Promise<InventoryLocation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.manage"); return repo.createLocation(c, o.businessId, input); }); }
  postMovement(o: InventoryOperation, input: MovementInput): Promise<StockMovement> {
    return this.run(o, async (c) => {
      await this.require(c, o.businessId, "inventory.manage");
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
    });
  }
  reserve(o: InventoryOperation, input: ReservationInput): Promise<Reservation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.reserve"); return repo.createReservation(c, o.businessId, input); }); }
  release(o: InventoryOperation, id: string): Promise<Reservation> { return this.run(o, async (c) => { await this.require(c, o.businessId, "inventory.reserve"); const row = await repo.releaseReservation(c, o.businessId, id); if (!row) throw notFoundError("Active reservation not found"); return row; }); }
  private async require(c: Parameters<typeof repo.listBalances>[0], businessId: string, permission: string): Promise<void> { return authorization.requirePermission(c, businessId, permission); }
  private async run<T>(o: InventoryOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> { try { return await withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), work); } catch (e) { if (e instanceof DatabaseError || (e && typeof e === "object" && "code" in e && "statusCode" in e)) throw e; throw normalizeDatabaseError(e); } }
}
