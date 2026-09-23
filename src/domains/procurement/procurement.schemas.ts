import { z } from "zod";

const uuid = z.string().uuid();
export const businessParamsSchema = z.object({ businessId: uuid });
export const orderParamsSchema = z.object({ businessId: uuid, orderId: uuid });

export const purchaseOrderSchema = z.object({
  supplierAccountId: uuid,
  storeId: uuid,
  orderNumber: z.string().trim().min(1).max(80),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
  lines: z.array(z.object({
    inventoryItemId: uuid.optional(),
    variantId: uuid.nullable().optional(),
    productId: uuid.nullable().optional(),
    quantityOrdered: z.number().positive(),
    unitCostMinor: z.number().int().nonnegative(),
  })).min(1),
});

export const updateOrderSchema = z.object({
  status: z.enum(["draft", "approved", "sent", "partially_received", "received", "cancelled"]).optional(),
  expectedAt: z.string().datetime().nullable().optional(),
  notes: z.string().max(2000).optional(),
});

export const listOrdersQuery = z.object({
  storeId: uuid.optional(),
  supplierAccountId: uuid.optional(),
  status: z.enum(["draft", "approved", "sent", "partially_received", "received", "cancelled"]).optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(50),
});

export const receiptSchema = z.object({
  purchaseOrderId: uuid,
  inventoryLocationId: uuid,
  idempotencyKey: z.string().trim().min(1).max(160),
  lines: z.array(z.object({
    purchaseOrderLineId: uuid,
    inventoryItemId: uuid,
    quantityReceived: z.number().positive(),
    quantityRejected: z.number().nonnegative().optional(),
    unitCostMinor: z.number().int().nonnegative(),
  })).min(1),
});

export const listReceiptsQuery = z.object({
  purchaseOrderId: uuid.optional(),
  inventoryLocationId: uuid.optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(50),
});
