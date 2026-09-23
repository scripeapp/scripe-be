import { z } from "zod";
const uuid = z.string().uuid();
export const businessParamsSchema = z.object({ businessId: uuid });
export const itemParamsSchema = z.object({ businessId: uuid, itemId: uuid });
export const reservationParamsSchema = z.object({ businessId: uuid, reservationId: uuid });
export const movementSchema = z.object({ inventoryItemId: uuid, inventoryLocationId: uuid, quantity: z.number().finite().refine((v) => v !== 0), type: z.enum(["receipt", "sale", "return", "adjustment", "transfer_in", "transfer_out", "waste", "count", "reservation", "release"]), reason: z.string().trim().min(1).max(500), idempotencyKey: z.string().trim().min(1).max(160), unitCostMinor: z.number().int().min(0).nullable().optional() });
export const reservationSchema = z.object({ inventoryItemId: uuid, inventoryLocationId: uuid, quantity: z.number().finite().positive(), referenceType: z.string().trim().min(1).max(40), referenceId: z.string().trim().min(1).max(160), expiresAt: z.string().datetime().nullable().optional() });
export const balanceQuerySchema = z.object({ businessId: uuid, inventoryItemId: uuid.optional(), inventoryLocationId: uuid.optional() });
export const itemsQuerySchema = z.object({ businessId: uuid, status: z.enum(["active", "archived"]).optional(), search: z.string().trim().max(120).optional() });
export const movementsQuerySchema = z.object({ businessId: uuid, inventoryItemId: uuid.optional(), inventoryLocationId: uuid.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });
export const inventoryItemSchema = z.object({ name: z.string().trim().min(1).max(200), sku: z.string().trim().max(120).nullable().optional(), variantId: uuid.nullable().optional(), trackingMode: z.enum(["quantity", "lot", "serial"]).optional() });
export const inventoryLocationSchema = z.object({ locationId: uuid, name: z.string().trim().min(1).max(120) });

export const transferParamsSchema = z.object({ businessId: uuid, transferId: uuid });
export const transfersQuerySchema = z.object({ businessId: uuid, status: z.enum(["draft", "sent", "received", "cancelled"]).optional() });
export const createTransferSchema = z.object({
  reference: z.string().trim().min(1).max(80),
  fromLocationId: uuid,
  toLocationId: uuid,
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(z.object({ inventoryItemId: uuid, quantity: z.number().positive(), unitCostMinor: z.number().int().min(0).nullable().optional() })).min(1),
}).refine((v) => v.fromLocationId !== v.toLocationId, "Source and destination must differ");
export const receiveTransferSchema = z.object({
  lines: z.array(z.object({ lineId: uuid, quantityReceived: z.number().min(0) })).min(1),
});

export const countParamsSchema = z.object({ businessId: uuid, countId: uuid });
export const countsQuerySchema = z.object({ businessId: uuid, status: z.enum(["draft", "applied", "cancelled"]).optional() });
const countLineSchema = z.object({ inventoryItemId: uuid, countedQuantity: z.number().min(0) });
export const createCountSchema = z.object({
  reference: z.string().trim().min(1).max(80),
  locationId: uuid,
  scope: z.enum(["all", "selected"]).optional(),
  countDate: z.string().date().optional(),
  notes: z.string().trim().max(2000).optional(),
  lines: z.array(countLineSchema).optional(),
});
export const setCountLinesSchema = z.object({ lines: z.array(countLineSchema).min(1) });
