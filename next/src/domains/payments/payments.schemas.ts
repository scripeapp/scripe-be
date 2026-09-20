import { z } from "zod"; const uuid=z.string().uuid();
export const params=z.object({businessId:uuid});
export const recordPayment=z.object({orderId:uuid,method:z.enum(["cash","card","bank_transfer","online"]),assetCode:z.string().regex(/^[A-Z]{3}$/),amountMinor:z.number().int().positive(),status:z.enum(["pending","authorized","captured","failed","cancelled"]).optional(),externalReference:z.string().max(200).nullable().optional(),idempotencyKey:z.string().trim().min(1).max(160)});
