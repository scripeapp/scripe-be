import { z } from "zod";

const uuid = z.string().uuid();
const accountNumber = z.string().regex(/^\d{10}$/, "Enter a 10 digit account number");
const bvn = z.string().regex(/^\d{11}$/, "Enter an 11 digit BVN");
const bankCode = z.string().min(2).max(20);
const businessIdQuery = z.object({ business_id: uuid });
const businessIdBody = z.object({ business_id: uuid });

export const bankingSchemas = {
  businessIdQuery,
  businessIdBody,

  submitKyc: z.object({
    business_id: uuid,
    email: z.string().trim().email().max(255),
    first_name: z.string().trim().min(1).max(80),
    last_name: z.string().trim().min(1).max(80),
    phone: z.string().trim().min(7).max(30),
    bvn,
    bank_code: bankCode,
    account_number: accountNumber,
  }),

  requestVirtualAccount: z.object({
    business_id: uuid,
    preferred_bank: z.string().trim().min(2).max(80).optional(),
  }),

  requestWithdrawal: z
    .object({
      business_id: uuid,
      amount: z.coerce.number().positive(),
      pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
      idempotency_key: z.string().trim().min(8).max(80).optional(),
      bank_code: bankCode.optional(),
      account_number: accountNumber.optional(),
      account_name: z.string().trim().min(2).max(255).optional(),
    })
    .refine(
      (input) => {
        const supplied = [input.bank_code, input.account_number, input.account_name].filter(
          Boolean,
        ).length;
        return supplied === 0 || supplied === 3;
      },
      {
        message:
          "Provide the full destination account details or none — withdrawals without account details go to the business settlement account",
      },
    ),

  resetBvnPin: z.object({
    business_id: uuid,
    bvn_last4: z.string().regex(/^\d{4}$/, "Enter the last 4 digits of your BVN"),
  }),

  finalizeWithdrawal: z.object({
    business_id: uuid,
    transfer_code: z.string().trim().min(4).max(120),
    otp: z.string().trim().min(4).max(20),
  }),

  listTransactions: businessIdQuery.extend({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
  }),

  resolveBankAccount: businessIdQuery.extend({
    account_number: accountNumber,
    bank_code: bankCode,
  }),
};

export type SubmitBankingKycInput = z.infer<typeof bankingSchemas.submitKyc>;
export type RequestVirtualAccountInput = z.infer<
  typeof bankingSchemas.requestVirtualAccount
>;
export type RequestWithdrawalInput = z.infer<
  typeof bankingSchemas.requestWithdrawal
>;
export type FinalizeWithdrawalInput = z.infer<
  typeof bankingSchemas.finalizeWithdrawal
>;
export type ResetBvnPinInput = z.infer<typeof bankingSchemas.resetBvnPin>;

export type ResolveBankAccountInput = z.infer<
  typeof bankingSchemas.resolveBankAccount
>;
