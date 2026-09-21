import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import { postJournalEntry } from "../accounting/accounting.service.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./returns.repository.js";
import type { CreateReturnInput, Return, ReturnLine, ReturnLineRow, ReturnRow, ReturnsOperation } from "./returns.types.js";

export class ReturnsService {
  constructor(private readonly database: Database) {}

  async create(operation: ReturnsOperation, input: CreateReturnInput): Promise<Return> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "return.manage");

      if (!(await repository.verifyOrder(context, operation.businessId, input.orderId))) {
        throw notFoundError("Order not found");
      }

      const needsRestock = input.lines.some((line) => line.restock);
      if (needsRestock) {
        await requirePermission(context, operation.businessId, "inventory.manage");
        if (!input.inventoryLocationId) throw validationError("inventoryLocationId is required when restocking a return line");
      }

      interface PreparedLine {
        readonly input: CreateReturnInput["lines"][number];
        readonly inventoryItemId: string | null;
        readonly amountMinor: bigint;
      }
      const prepared: PreparedLine[] = [];
      for (const line of input.lines) {
        const orderLine = await repository.findOrderLineForReturn(context, operation.businessId, input.orderId, line.orderLineId);
        if (!orderLine) throw notFoundError(`Order line ${line.orderLineId} not found on this order`);
        const alreadyReturned = await repository.sumReturnedQuantity(context, operation.businessId, line.orderLineId);
        if (alreadyReturned + line.quantity > orderLine.quantity) {
          throw conflictError(`Return quantity for order line ${line.orderLineId} exceeds the remaining returnable quantity`);
        }
        if (line.restock && !orderLine.inventoryItemId) {
          throw validationError(`Order line ${line.orderLineId} has no tracked inventory item to restock`);
        }
        const amountMinor = BigInt(orderLine.unitPriceMinor) * BigInt(line.quantity);
        prepared.push({ input: line, inventoryItemId: orderLine.inventoryItemId, amountMinor });
      }

      const refundableAmountMinor = prepared.reduce((sum, line) => sum + line.amountMinor, 0n);
      const created = await repository.createReturn(context, operation.businessId, operation.userId, input.orderId, input.reason, input.inventoryLocationId ?? null, refundableAmountMinor);

      // Recognizes the refund obligation the moment the return is recorded,
      // not when it's actually paid back - the same "record the event, not
      // the disbursement" treatment payables' bill creation uses, since
      // returns has no real refund-execution path either (no gateway
      // refund call happens anywhere in this domain).
      if (refundableAmountMinor > 0n) {
        await postJournalEntry(context, operation.businessId, operation.userId, {
          description: "Return recorded",
          sourceType: "return",
          sourceId: created.id,
          lines: [
            { accountCode: LEDGER_ACCOUNT_CODES.SALES_RETURNS, direction: "debit", amountMinor: refundableAmountMinor, assetCode: "NGN" },
            { accountCode: LEDGER_ACCOUNT_CODES.REFUNDS_PAYABLE, direction: "credit", amountMinor: refundableAmountMinor, assetCode: "NGN" },
          ],
        });
      }

      const lines: ReturnLineRow[] = [];
      for (const line of prepared) {
        const row = await repository.createReturnLine(context, operation.businessId, created.id, line.input.orderLineId, line.input.quantity, line.input.condition, line.input.restock, line.amountMinor);
        lines.push(row);
        if (line.input.restock && line.inventoryItemId) {
          await repository.restockLine(
            context,
            operation.businessId,
            line.inventoryItemId,
            input.inventoryLocationId!,
            line.input.quantity,
            operation.userId,
            operation.requestId,
            `${created.id}:${line.input.orderLineId}`,
          );
        }
      }

      return toReturn(created, lines);
    });
  }

  async list(operation: ReturnsOperation, orderId?: string): Promise<Return[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "return.read");
      const rows = await repository.listReturns(context, operation.businessId, orderId);
      return Promise.all(rows.map(async (row) => toReturn(row, await repository.listReturnLines(context, operation.businessId, row.id))));
    });
  }

  async get(operation: ReturnsOperation, returnId: string): Promise<Return> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "return.read");
      const row = await repository.findReturn(context, operation.businessId, returnId);
      if (!row) throw notFoundError("Return not found");
      const lines = await repository.listReturnLines(context, operation.businessId, returnId);
      return toReturn(row, lines);
    });
  }

  private async run<T>(operation: ReturnsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toReturn(row: ReturnRow, lines: ReturnLineRow[]): Return {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
    lines: lines.map(toReturnLine),
  };
}

function toReturnLine(row: ReturnLineRow): ReturnLine {
  return { ...row, createdAt: row.createdAt.toISOString() };
}
