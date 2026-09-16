import { z } from "zod";

export const paymentSchemas = {
  verifyParams: z.object({
    reference: z.string().min(1, "Transaction reference is required"),
  }),

  listTransactions: z.object({
    business_id: z.string().uuid(),
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),
};

export type VerifyPaymentParams = z.infer<typeof paymentSchemas.verifyParams>;
export type ListPaymentTransactionsInput = z.infer<
  typeof paymentSchemas.listTransactions
>;
