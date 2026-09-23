export type InventoryStatus = "active" | "archived";
export type StockTransactionType = "receipt" | "sale" | "return" | "adjustment" | "transfer_in" | "transfer_out" | "waste" | "count" | "reservation" | "release";
export interface InventoryItem { readonly id: string; readonly businessId: string; readonly variantId: string | null; readonly name: string; readonly sku: string | null; readonly trackingMode: "quantity" | "lot" | "serial"; readonly status: InventoryStatus; readonly createdAt: string; readonly updatedAt: string; }
export interface InventoryLocation { readonly id: string; readonly businessId: string; readonly locationId: string; readonly name: string; readonly status: InventoryStatus; readonly createdAt: string; }
export interface StockBalance { readonly id: string; readonly businessId: string; readonly inventoryItemId: string; readonly inventoryLocationId: string; readonly onHand: string; readonly reserved: string; readonly available: string; readonly updatedAt: string; }
export interface StockMovement { readonly id: string; readonly transactionId: string; readonly inventoryItemId: string; readonly inventoryLocationId: string; readonly quantity: string; readonly unitCostMinor: string | null; readonly createdAt: string; }
export interface Reservation { readonly id: string; readonly businessId: string; readonly inventoryItemId: string; readonly inventoryLocationId: string; readonly quantity: string; readonly referenceType: string; readonly referenceId: string; readonly status: "active" | "released" | "expired"; readonly expiresAt: string | null; readonly createdAt: string; readonly releasedAt: string | null; }
export interface InventoryOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface MovementInput { readonly inventoryItemId: string; readonly inventoryLocationId: string; readonly quantity: number; readonly type: StockTransactionType; readonly reason: string; readonly idempotencyKey: string; readonly unitCostMinor?: number | null; }
export interface ReservationInput { readonly inventoryItemId: string; readonly inventoryLocationId: string; readonly quantity: number; readonly referenceType: string; readonly referenceId: string; readonly expiresAt?: string | null; }
export interface InventoryItemInput { readonly name: string; readonly sku?: string | null; readonly variantId?: string | null; readonly trackingMode?: "quantity" | "lot" | "serial"; }
export interface InventoryLocationInput { readonly locationId: string; readonly name: string; }

export type StockTransferStatus = "draft" | "sent" | "received" | "cancelled";
export interface StockTransferLine { readonly id: string; readonly businessId: string; readonly transferId: string; readonly inventoryItemId: string; readonly quantity: string; readonly quantityReceived: string; readonly unitCostMinor: string | null; readonly createdAt: string; }
export interface StockTransfer { readonly id: string; readonly businessId: string; readonly reference: string; readonly status: StockTransferStatus; readonly fromInventoryLocationId: string; readonly toInventoryLocationId: string; readonly notes: string; readonly createdBy: string; readonly createdAt: string; readonly updatedAt: string; readonly sentAt: string | null; readonly receivedAt: string | null; }
export interface StockTransferLineInput { readonly inventoryItemId: string; readonly quantity: number; readonly unitCostMinor?: number | null; }
export interface CreateStockTransferInput { readonly reference: string; readonly fromLocationId: string; readonly toLocationId: string; readonly notes?: string; readonly lines: readonly StockTransferLineInput[]; }
export interface ReceiveStockTransferLineInput { readonly lineId: string; readonly quantityReceived: number; }
export interface ReceiveStockTransferInput { readonly lines: readonly ReceiveStockTransferLineInput[]; }

export type StockCountStatus = "draft" | "applied" | "cancelled";
export interface StockCountLine { readonly id: string; readonly businessId: string; readonly countId: string; readonly inventoryItemId: string; readonly systemQuantity: string; readonly countedQuantity: string; readonly createdAt: string; }
export interface StockCount { readonly id: string; readonly businessId: string; readonly reference: string; readonly status: StockCountStatus; readonly inventoryLocationId: string; readonly scope: "all" | "selected"; readonly countDate: string; readonly notes: string; readonly createdBy: string; readonly createdAt: string; readonly updatedAt: string; readonly appliedAt: string | null; }
export interface StockCountLineInput { readonly inventoryItemId: string; readonly countedQuantity: number; }
export interface CreateStockCountInput { readonly reference: string; readonly locationId: string; readonly scope?: "all" | "selected"; readonly countDate?: string; readonly notes?: string; readonly lines?: readonly StockCountLineInput[]; }
export interface SetStockCountLinesInput { readonly lines: readonly StockCountLineInput[]; }
