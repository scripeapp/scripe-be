import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const orderParamsSchema = businessParamsSchema.extend({
  orderId: z.string().uuid(),
});

export const documentParamsSchema = businessParamsSchema.extend({
  documentId: z.string().uuid(),
});
