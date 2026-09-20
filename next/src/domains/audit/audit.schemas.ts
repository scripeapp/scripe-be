import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const listQuerySchema = z.object({
  action: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
