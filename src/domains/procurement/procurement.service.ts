import type { Database } from "../../db/database.types.js";
import { withDatabaseContext } from "../../db/database-context.js";
import { withIdentity } from "../../db/principal.js";
import { emailSender } from "../../shared/email.js";
import { notFoundError } from "../../shared/errors.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import * as authorization from "../authorization/authorization.service.js";
import * as repo from "./procurement.repository.js";
import type {
  GoodsReceiptInput,
  ListGoodsReceiptsFilter,
  ListPurchaseOrdersFilter,
  ProcurementOperation,
  PurchaseOrderInput,
  PurchaseOrderRow,
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
      const supplierAccountId = await repo.resolveSupplierAccountId(c, o.businessId, i.supplierAccountId);
      if (!supplierAccountId) throw notFoundError("Supplier not found");
      return repo.createPurchaseOrder(c, o.businessId, o.userId, { ...i, supplierAccountId });
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

  /**
   * Marks the order sent, then emails it to the supplier. The email goes
   * out after the status change commits, so a mail failure never undoes
   * the "sent" mark; the caller is told whether it went and, if not, why.
   */
  async sendOrder(o: ProcurementOperation, orderId: string): Promise<{ purchaseOrder: PurchaseOrderRow; emailSent: boolean; emailError: "no_supplier_email" | "send_failed" | null }> {
    const prepared = await this.run(o, async (c) => {
      await authorization.requirePermission(c, o.businessId, "procurement.manage");
      const updated = await repo.updatePurchaseOrder(c, o.businessId, orderId, { status: "sent" });
      if (!updated) throw notFoundError("Purchase order not found");
      const order = await repo.findPurchaseOrderById(c, o.businessId, orderId);
      const lines = await repo.listPurchaseOrderLines(c, o.businessId, orderId);
      const recipient = await repo.findOrderEmailRecipient(c, o.businessId, orderId);
      const sender = await authorizationRepository.findMembershipByUserId(c, o.businessId, o.userId);
      return { updated, order: order ?? updated, lines, recipient, replyToEmail: sender?.email ?? null };
    });

    if (!prepared.recipient?.supplierEmail) return { purchaseOrder: prepared.updated, emailSent: false, emailError: "no_supplier_email" };
    try {
      await emailSender.sendPurchaseOrder(prepared.recipient.supplierEmail, {
        businessName: prepared.recipient.businessName,
        supplierName: prepared.recipient.supplierName,
        orderNumber: prepared.order.orderNumber,
        orderDate: formatDate(prepared.order.orderedAt ?? prepared.order.createdAt),
        expectedDate: prepared.order.expectedAt ? formatDate(prepared.order.expectedAt) : null,
        lines: prepared.lines.map((line) => ({
          name: line.itemName ?? line.sku ?? "Item",
          quantity: String(Number(line.quantityOrdered)),
          unitCostFormatted: formatNaira(BigInt(line.unitCostMinor)),
          totalFormatted: formatNaira(BigInt(line.unitCostMinor) * BigInt(Math.round(Number(line.quantityOrdered)))),
        })),
        totalFormatted: formatNaira(
          prepared.lines.reduce((sum, line) => sum + BigInt(line.unitCostMinor) * BigInt(Math.round(Number(line.quantityOrdered))), 0n),
        ),
        notes: prepared.order.notes || null,
        replyToEmail: prepared.replyToEmail,
      });
      return { purchaseOrder: prepared.updated, emailSent: true, emailError: null };
    } catch (error) {
      console.warn(`Purchase order ${prepared.order.orderNumber} email failed:`, error);
      return { purchaseOrder: prepared.updated, emailSent: false, emailError: "send_failed" };
    }
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

function formatNaira(minor: bigint): string {
  return `₦${(Number(minor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Accepts a timestamp or a Postgres timestamp string; shows e.g. "3 Oct 2026". */
function formatDate(value: string): string {
  const parsed = new Date(value.replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? value.slice(0, 10) : parsed.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
