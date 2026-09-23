import { z } from "zod";

const accountNumber = z.string().regex(/^\d{10}$/, "Enter a 10 digit account number");
const bankCode = z.string().min(2).max(20);
const bvn = z.string().regex(/^\d{11}$/, "Enter an 11 digit BVN");

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const submitKycSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    return {
      email: val.email,
      firstName: val.firstName ?? val.first_name,
      lastName: val.lastName ?? val.last_name,
      phone: val.phone,
      bvn: val.bvn,
      bankCode: val.bankCode ?? val.bank_code,
      accountNumber: val.accountNumber ?? val.account_number,
      dateOfBirth: val.dateOfBirth ?? val.date_of_birth,
      gender: val.gender,
    };
  }
  return val;
}, z.object({
  email: z.string().trim().email().max(255),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(30),
  bvn,
  bankCode,
  accountNumber,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
}));

export const requestVirtualAccountSchema = z.object({
  preferredBank: z.string().trim().min(2).max(80).optional(),
});

export const requestWithdrawalSchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    const rawAmount = val.amountMinor ?? (val.amount !== undefined ? Math.round(Number(val.amount) * 100) : undefined);
    return {
      amountMinor: rawAmount,
      bankCode: val.bankCode ?? val.bank_code ?? val.bank,
      accountNumber: val.accountNumber ?? val.account_number,
      accountName: val.accountName ?? val.account_name ?? "Withdrawal Beneficiary",
      idempotencyKey: val.idempotencyKey ?? val.idempotency_key ?? `wd_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
    };
  }
  return val;
}, z.object({
  amountMinor: z.number().int().positive(),
  bankCode,
  accountNumber,
  accountName: z.string().trim().min(2).max(255),
  idempotencyKey: z.string().trim().min(8).max(80),
}));

export const finalizeWithdrawalSchema = z.object({
  transferCode: z.string().trim().min(4).max(120),
  otp: z.string().trim().min(4).max(20),
});

export const resolveBankAccountQuerySchema = z.preprocess((val: any) => {
  if (val && typeof val === "object") {
    return {
      accountNumber: val.accountNumber ?? val.account_number,
      bankCode: val.bankCode ?? val.bank_code,
    };
  }
  return val;
}, z.object({
  accountNumber,
  bankCode,
}));

export const listWalletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

