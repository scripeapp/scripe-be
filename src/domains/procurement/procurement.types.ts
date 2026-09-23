export interface PurchaseOrderLineInput {
  readonly inventoryItemId?: string;
  readonly variantId?: string | null;
  readonly productId?: string | null;
  readonly quantityOrdered: number;
  readonly unitCostMinor: number;
}

export interface PurchaseOrderInput {
  readonly supplierAccountId: string;
  readonly storeId: string;
  readonly orderNumber: string;
  readonly expectedAt?: string | null;
  readonly notes?: string;
  readonly lines: PurchaseOrderLineInput[];
}

export interface GoodsReceiptLineInput {
  readonly purchaseOrderLineId: string;
  readonly inventoryItemId: string;
  readonly quantityReceived: number;
  readonly quantityRejected?: number;
  readonly unitCostMinor: number;
}

export interface GoodsReceiptInput {
  readonly purchaseOrderId: string;
  readonly inventoryLocationId: string;
  readonly idempotencyKey: string;
  readonly lines: GoodsReceiptLineInput[];
}

export interface ProcurementOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface ListPurchaseOrdersFilter {
  readonly storeId?: string;
  readonly supplierAccountId?: string;
  readonly status?: string;
  readonly search?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface PurchaseOrderRow {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly supplierAccountId: string;
  readonly status: string;
  readonly orderNumber: string;
  readonly orderedAt: string | null;
  readonly expectedAt: string | null;
  readonly notes: string;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly supplierName?: string | null;
  readonly storeName?: string | null;
  readonly itemsCount?: number;
  readonly totalMinor?: string;
}

export interface PurchaseOrderLineRow {
  readonly id: string;
  readonly businessId: string;
  readonly purchaseOrderId: string;
  readonly inventoryItemId: string;
  readonly quantityOrdered: string;
  readonly quantityReceived: string;
  readonly unitCostMinor: string;
  readonly createdAt: string;
  readonly itemName?: string | null;
  readonly sku?: string | null;
}

export interface GoodsReceiptRow {
  readonly id: string;
  readonly businessId: string;
  readonly purchaseOrderId: string;
  readonly inventoryLocationId: string;
  readonly status: string;
  readonly receivedAt: string;
  readonly receivedBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
  readonly lines?: GoodsReceiptLineRow[];
}

export interface GoodsReceiptLineRow {
  readonly id: string;
  readonly businessId: string;
  readonly receiptId: string;
  readonly purchaseOrderLineId: string;
  readonly inventoryItemId: string;
  readonly quantityReceived: string;
  readonly quantityRejected: string;
  readonly unitCostMinor: string;
  readonly createdAt: string;
  readonly itemName?: string | null;
}

export interface UpdatePurchaseOrderInput {
  readonly status?: "draft" | "approved" | "sent" | "partially_received" | "received" | "cancelled";
  readonly expectedAt?: string | null;
  readonly notes?: string;
}

export interface ListGoodsReceiptsFilter {
  readonly purchaseOrderId?: string;
  readonly inventoryLocationId?: string;
  readonly page?: number;
  readonly pageSize?: number;
}
