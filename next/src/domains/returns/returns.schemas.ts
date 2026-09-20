import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const returnParamsSchema = businessParamsSchema.extend({
  returnId: z.string().uuid(),
});

export const listQuerySchema = z.object({
  orderId: z.string().uuid().optional(),
});

export const createReturnSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(1).max(500),
  inventoryLocationId: z.string().uuid().nullable().optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.string().uuid(),
        quantity: z.number().int().positive(),
        condition: z.enum(["sellable", "damaged", "defective"]),
        restock: z.boolean().default(false),
      }),
    )
    .min(1),
});
