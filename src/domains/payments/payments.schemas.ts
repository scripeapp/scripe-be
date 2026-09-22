import { z } from "zod"; const uuid=z.string().uuid();
export const params=z.object({businessId:uuid});
export const recordPayment=z.object({orderId:uuid,method:z.enum(["cash","card","bank_transfer","online"]),assetCode:z.string().regex(/^[A-Z]{3}$/),amountMinor:z.number().int().positive(),status:z.enum(["pending","authorized","captured","failed","cancelled"]).optional(),externalReference:z.string().max(200).nullable().optional(),idempotencyKey:z.string().trim().min(1).max(160)});

export const initiateCheckout = z.object({
  orderId: uuid,
  gateway: z.enum(["paystack", "flutterwave"]),
  assetCode: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: z.number().int().positive(),
  email: z.string().trim().email().max(255),
  callbackUrl: z.string().url().optional(),
  idempotencyKey: z.string().trim().min(1).max(160),
});

export const checkoutParams = z.object({ businessId: uuid, reference: z.string().trim().min(1).max(200) });
