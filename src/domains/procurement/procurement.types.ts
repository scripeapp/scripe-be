export interface PurchaseOrderLineInput { readonly inventoryItemId: string; readonly quantityOrdered: number; readonly unitCostMinor: number; }
export interface PurchaseOrderInput { readonly supplierAccountId: string; readonly storeId: string; readonly orderNumber: string; readonly expectedAt?: string | null; readonly notes?: string; readonly lines: PurchaseOrderLineInput[]; }
export interface GoodsReceiptLineInput { readonly purchaseOrderLineId: string; readonly inventoryItemId: string; readonly quantityReceived: number; readonly quantityRejected?: number; readonly unitCostMinor: number; }
export interface GoodsReceiptInput { readonly purchaseOrderId: string; readonly inventoryLocationId: string; readonly idempotencyKey: string; readonly lines: GoodsReceiptLineInput[]; }
export interface ProcurementOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
