import { StoreService } from "../services/store.service";
import { createMockQueryBuilder } from "./test-utils";

const STORE_ID = "11111111-1111-4111-8111-111111111111";
const SUPPLIER_ID = "22222222-2222-4222-8222-222222222222";
const BILL_ID = "33333333-3333-4333-8333-333333333333";
const USER_ID = "44444444-4444-4444-8444-444444444444";

const buildClient = (
  tableBuilders: Record<string, any>,
  rpcResults: Record<string, { data: unknown; error: unknown }> = {},
) => {
  const from = jest.fn((table: string) => {
    if (table in tableBuilders) return tableBuilders[table];
    return createMockQueryBuilder(null);
  });
  const rpc = jest.fn((name: string) => rpcResults[name] ?? { data: null, error: null });
  return { from, rpc } as any;
};

describe("StoreService – supplier operations", () => {
  describe("listSuppliers", () => {
    it("returns suppliers with product_count, total_spend, and outstanding_payable", async () => {
      const suppliersQB = createMockQueryBuilder([
        { id: SUPPLIER_ID, name: "Acme" },
      ]);
      const billsQB = createMockQueryBuilder([
        { supplier_id: SUPPLIER_ID, amount: 1000, paid_amount: 250, status: "partially_paid" },
        { supplier_id: SUPPLIER_ID, amount: 500, paid_amount: 500, status: "paid" },
      ]);
      const supplierProductsQB = createMockQueryBuilder([
        { supplier_id: SUPPLIER_ID, product_id: "product-1" },
        { supplier_id: SUPPLIER_ID, product_id: "product-2" },
      ]);
      const storesQB = createMockQueryBuilder({ id: STORE_ID });

      const client = buildClient({
        suppliers: suppliersQB,
        supplier_bills: billsQB,
        supplier_products: supplierProductsQB,
        stores: storesQB,
      });
      const service = new StoreService(client);

      const result = await service.listSuppliers(STORE_ID);

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        product_count: 2,
        total_spend: 1500,
        outstanding_payable: 750,
      });
    });

    it("returns zero spend when no bills exist", async () => {
      const suppliersQB = createMockQueryBuilder([
        { id: SUPPLIER_ID, name: "Acme" },
      ]);
      const billsQB = createMockQueryBuilder([]);
      const storesQB = createMockQueryBuilder({ id: STORE_ID });

      const client = buildClient({
        suppliers: suppliersQB,
        supplier_bills: billsQB,
        supplier_products: createMockQueryBuilder([]),
        stores: storesQB,
      });
      const service = new StoreService(client);

      const result = await service.listSuppliers(STORE_ID);

      expect(result[0].total_spend).toBe(0);
      expect(result[0].outstanding_payable).toBe(0);
    });
  });

  describe("listSupplierBills", () => {
    it("returns paginated bills for a supplier", async () => {
      const suppliersQB = createMockQueryBuilder({ id: SUPPLIER_ID });
      const billsQB = createMockQueryBuilder([{ id: BILL_ID, bill_number: "BIL-001", amount: 5000 }]);
      // Override then to include count for paginated select queries
      billsQB.then = (resolve: any) => resolve({ data: [{ id: BILL_ID, bill_number: "BIL-001", amount: 5000 }], error: null, count: 1 });

      const client = buildClient({
        suppliers: suppliersQB,
        supplier_bills: billsQB,
        stores: createMockQueryBuilder({ id: STORE_ID }),
      });
      const service = new StoreService(client);

      const result = await service.listSupplierBills(STORE_ID, SUPPLIER_ID, 1, 10);

      expect(result.bills).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
    });
  });

  describe("getSupplierBillItems", () => {
    it("returns line items for a valid bill", async () => {
      const billQB = createMockQueryBuilder({ id: BILL_ID });
      const itemsQB = createMockQueryBuilder([
        { id: "item-1", bill_id: BILL_ID, description: "Cotton rolls", quantity: 10, unit_price: 500, total: 5000 },
      ]);

      const client = buildClient({
        supplier_bills: billQB,
        supplier_bill_items: itemsQB,
        stores: createMockQueryBuilder({ id: STORE_ID }),
      });
      const service = new StoreService(client);

      const result = await service.getSupplierBillItems(STORE_ID, SUPPLIER_ID, BILL_ID);

      expect(result).toHaveLength(1);
      expect(result[0].description).toBe("Cotton rolls");
    });

    it("throws 404 when bill not found", async () => {
      const billQB = createMockQueryBuilder(null, { message: "not found" });
      const client = buildClient({
        supplier_bills: billQB,
        stores: createMockQueryBuilder({ id: STORE_ID }),
      });
      const service = new StoreService(client);

      await expect(
        service.getSupplierBillItems(STORE_ID, SUPPLIER_ID, BILL_ID),
      ).rejects.toThrow("Supplier bill not found");
    });
  });

  describe("addSupplierBillItem", () => {
    it("inserts a line item and updates bill items_count", async () => {
      const billCheckQB = createMockQueryBuilder({ id: BILL_ID });
      const itemInsertQB = createMockQueryBuilder({ id: "item-1", bill_id: BILL_ID, description: "Box of nails", quantity: 5, unit_price: 200, total: 1000 });
      const countQB = createMockQueryBuilder(null);
      countQB.then = (resolve: any) => resolve({ data: null, error: null, count: 3 });
      const billUpdateQB = createMockQueryBuilder(null);

      let billCallCount = 0;
      let itemCountCallCount = 0;
      const originalFrom = jest.fn((table: string) => {
        if (table === "supplier_bills") {
          billCallCount++;
          if (billCallCount === 1) return billCheckQB;
          return billUpdateQB;
        }
        if (table === "supplier_bill_items") {
          itemCountCallCount++;
          if (itemCountCallCount === 1) return itemInsertQB;
          return countQB;
        }
        if (table === "stores") return createMockQueryBuilder({ id: STORE_ID });
        return createMockQueryBuilder(null);
      });

      const client = { from: originalFrom } as any;
      const service = new StoreService(client);

      const result = await service.addSupplierBillItem(STORE_ID, SUPPLIER_ID, BILL_ID, {
        description: "Box of nails",
        quantity: 5,
        unit_price: 200,
      });

      expect(result.description).toBe("Box of nails");
    });
  });

  describe("listSupplierPayments", () => {
    it("returns paginated payments for a supplier", async () => {
      const suppliersQB = createMockQueryBuilder({ id: SUPPLIER_ID });
      const paymentsQB = createMockQueryBuilder([{ id: "pay-1", amount: 3000, method: "bank_transfer" }]);
      paymentsQB.then = (resolve: any) => resolve({ data: [{ id: "pay-1", amount: 3000, method: "bank_transfer" }], error: null, count: 1 });

      const client = buildClient({
        suppliers: suppliersQB,
        supplier_payments: paymentsQB,
        stores: createMockQueryBuilder({ id: STORE_ID }),
      });
      const service = new StoreService(client);

      const result = await service.listSupplierPayments(STORE_ID, SUPPLIER_ID, 1, 10);

      expect(result.payments).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe("createSupplierPayment", () => {
    it("records and reconciles a linked payment through the atomic RPC", async () => {
      const payment = { id: "pay-1", amount: 5000, method: "bank_transfer", status: "successful" };
      const client = buildClient({}, {
        record_supplier_payment: { data: payment, error: null },
      });
      const service = new StoreService(client);

      const result = await service.createSupplierPayment(
        STORE_ID,
        SUPPLIER_ID,
        { bill_id: BILL_ID, amount: 5000, method: "bank_transfer" },
        USER_ID,
      );

      expect(result.amount).toBe(5000);
      expect(client.rpc).toHaveBeenCalledWith("record_supplier_payment", expect.objectContaining({
        p_bill_id: BILL_ID,
        p_status: "successful",
      }));
    });

    it("creates a payment without a linked bill", async () => {
      const client = buildClient({}, {
        record_supplier_payment: {
          data: { id: "pay-2", amount: 1000, method: "cash", status: "successful" },
          error: null,
        },
      });
      const service = new StoreService(client);

      const result = await service.createSupplierPayment(
        STORE_ID,
        SUPPLIER_ID,
        { amount: 1000, method: "cash" },
        USER_ID,
      );

      expect(result.amount).toBe(1000);
      expect(client.rpc).toHaveBeenCalledWith("record_supplier_payment", expect.objectContaining({
        p_bill_id: null,
      }));
    });
  });

  describe("createStockReceipt", () => {
    it("posts the receipt through the atomic RPC and returns its lines", async () => {
      const receipt = {
        id: "55555555-5555-4555-8555-555555555555",
        supplier_id: SUPPLIER_ID,
        status: "completed",
        lines: [{ product_id: "66666666-6666-4666-8666-666666666666", quantity_received: 4 }],
      };
      const client = buildClient(
        { stock_receipts: createMockQueryBuilder(receipt) },
        { create_completed_stock_receipt: { data: { id: receipt.id }, error: null } },
      );
      const service = new StoreService(client);

      const result = await service.createStockReceipt(
        STORE_ID,
        SUPPLIER_ID,
        {
          lines: [{
            product_id: "66666666-6666-4666-8666-666666666666",
            quantity_received: 4,
            unit_cost: 125,
          }],
        },
        USER_ID,
      );

      expect(result).toEqual(receipt);
      expect(client.rpc).toHaveBeenCalledWith(
        "create_completed_stock_receipt",
        expect.objectContaining({ p_supplier_id: SUPPLIER_ID, p_lines: expect.any(Array) }),
      );
    });
  });
});
