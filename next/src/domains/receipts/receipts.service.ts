import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./receipts.repository.js";
import type { FiscalDocument, FiscalDocumentRow, ReceiptsOperation } from "./receipts.types.js";

export class ReceiptsService {
  constructor(private readonly database: Database) {}

  async list(operation: ReceiptsOperation): Promise<FiscalDocument[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "receipt.read");
      return (await repository.list(context, operation.businessId)).map(toFiscalDocument);
    });
  }

  async getForOrder(operation: ReceiptsOperation, orderId: string): Promise<FiscalDocument> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "receipt.read");
      const row = await repository.findForOrder(context, operation.businessId, orderId);
      if (!row) throw notFoundError("No receipt has been issued for this order");
      return toFiscalDocument(row);
    });
  }

  async get(operation: ReceiptsOperation, documentId: string): Promise<FiscalDocument> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "receipt.read");
      const row = await repository.findById(context, operation.businessId, documentId);
      if (!row) throw notFoundError("Receipt not found");
      return toFiscalDocument(row);
    });
  }

  private async run<T>(operation: ReceiptsOperation, work: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function toFiscalDocument(row: FiscalDocumentRow): FiscalDocument {
  return { ...row, issuedAt: row.issuedAt.toISOString() };
}
