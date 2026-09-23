import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { withIdentity } from "../../db/principal.js";
import { notFoundError } from "../../shared/errors.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./procurement.repository.js";
import type {
  GoodsReceiptInput,
  ListGoodsReceiptsFilter,
  ListPurchaseOrdersFilter,
  ProcurementOperation,
  PurchaseOrderInput,
  UpdatePurchaseOrderInput,
} from "./procurement.types.js";

export class ProcurementService {
  constructor(private readonly database: Database) {}

  async listOrders(o: ProcurementOperation, f: ListPurchaseOrdersFilter) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.read");
      return repo.listPurchaseOrders(c, o.businessId, f);
    });
  }

  async getOrder(o: ProcurementOperation, orderId: string) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.read");
      const order = await repo.findPurchaseOrderById(c, o.businessId, orderId);
      if (!order) throw notFoundError("Purchase order not found");
      const lines = await repo.listPurchaseOrderLines(c, o.businessId, orderId);
      const receipts = await repo.listPurchaseOrderReceipts(c, o.businessId, orderId);
      return { purchaseOrder: order, lines, receipts };
    });
  }

  async createOrder(o: ProcurementOperation, i: PurchaseOrderInput) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.manage");
      return repo.createPurchaseOrder(c, o.businessId, o.userId, i);
    });
  }

  async updateOrder(o: ProcurementOperation, orderId: string, input: UpdatePurchaseOrderInput) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.manage");
      const updated = await repo.updatePurchaseOrder(c, o.businessId, orderId, input);
      if (!updated) throw notFoundError("Purchase order not found");
      return updated;
    });
  }

  async sendOrder(o: ProcurementOperation, orderId: string) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.manage");
      const updated = await repo.updatePurchaseOrder(c, o.businessId, orderId, { status: "sent" });
      if (!updated) throw notFoundError("Purchase order not found");
      return { purchaseOrder: updated, emailSent: false };
    });
  }

  async receive(o: ProcurementOperation, i: GoodsReceiptInput) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.manage");
      const r = await repo.createReceipt(c, o.businessId, o.userId, o.requestId, i);
      if (!r) throw new Error("Receipt idempotency key already used");
      return r;
    });
  }

  async listReceipts(o: ProcurementOperation, f: ListGoodsReceiptsFilter) {
    return this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.read");
      return repo.listGoodsReceipts(c, o.businessId, f);
    });
  }

  private run<T>(o: ProcurementOperation, w: Parameters<typeof withDatabaseContext<T>>[2]): Promise<T> {
    return withDatabaseContext(this.database, withIdentity(o.requestId, o.userId, o.businessId), w);
  }
}
