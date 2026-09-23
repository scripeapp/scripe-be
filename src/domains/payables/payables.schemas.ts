/**
 * Zod request and response contracts for the bill, bill line, and bill payment
 * allocation domain belong here.
 */
import { z } from "zod";
const uuid = z.string().uuid();
export const params = z.object({ businessId: uuid, billId: uuid.optional() });
const line = z.object({ description: z.string().trim().min(1).max(500), quantity: z.number().positive(), unitAmountMinor: z.number().int().nonnegative(), taxMinor: z.number().int().nonnegative().optional(), lineTotalMinor: z.number().int().nonnegative(), accountCategory: z.string().trim().min(1).max(120), purchaseOrderId: uuid.nullable().optional(), purchaseOrderLineId: uuid.nullable().optional(), goodsReceiptId: uuid.nullable().optional() });
export const createBill = z.object({ supplierAccountId: uuid.nullable().optional(), billNumber: z.string().trim().min(1).max(100), billType: z.enum(["supplier","utility","tax","rent","other"]).optional(), assetCode: z.string().regex(/^[A-Z0-9]{2,12}$/).optional(), issuedAt: z.string().date().nullable().optional(), dueAt: z.string().date().nullable().optional(), subtotalMinor: z.number().int().nonnegative(), taxMinor: z.number().int().nonnegative().optional(), totalMinor: z.number().int().nonnegative(), notes: z.string().max(2000).optional(), lines: z.array(line).min(1) });
export const allocatePayment = z.object({ paymentReference: z.string().trim().min(1).max(160), amountMinor: z.number().int().positive(), assetCode: z.string().regex(/^[A-Z0-9]{2,12}$/), paidAt: z.string().datetime().optional() });
export const listBillsQuery = z.object({
  status: z.enum(["draft", "approved", "partially_paid", "paid", "voided"]).optional(),
  supplierAccountId: uuid.optional(),
  search: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
});
export const updateBill = z.object({
  status: z.enum(["draft", "approved", "voided"]).optional(),
  dueAt: z.string().date().nullable().optional(),
  notes: z.string().max(2000).optional(),
});
