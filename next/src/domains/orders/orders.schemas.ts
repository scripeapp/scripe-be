import { z } from "zod";
export const params = z.object({ businessId: z.string().uuid(), orderId: z.string().uuid() });
export const listQuery = z.object({ status: z.enum(["placed", "cancelled", "fulfilled", "refunded"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
