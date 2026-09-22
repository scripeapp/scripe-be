import { z } from "zod";
export const params = z.object({ businessId: z.string().uuid(), cartId: z.string().uuid(), lineId: z.string().uuid().optional() });
export const create = z.object({ storeId: z.string().uuid(), channelId: z.string().uuid(), customerPartyId: z.string().uuid().nullable().optional(), currency: z.string().regex(/^[A-Z]{3}$/).default("NGN") });
export const addLine = z.object({ productVariantId: z.string().uuid(), quantity: z.number().int().positive(), selectedModifiers: z.record(z.string(), z.unknown()).default({}), assetCode: z.string().regex(/^[A-Z]{3}$/).default("NGN") });
export const updateLine = z.object({ quantity: z.number().int().positive(), selectedModifiers: z.record(z.string(), z.unknown()).optional() });
export const checkout = z.object({ locationId: z.string().uuid().nullable().optional(), discountCode: z.string().trim().min(1).max(50).nullable().optional(), idempotencyKey: z.string().min(8).max(160) });
