import { z } from "zod";

const accountNumber = z.string().regex(/^\d{10}$/, "Enter a 10 digit account number");
const bankCode = z.string().min(2).max(20);
const bvn = z.string().regex(/^\d{11}$/, "Enter an 11 digit BVN");

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const submitKycSchema = z.object({
  email: z.string().trim().email().max(255),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(30),
  bvn,
  bankCode,
  accountNumber,
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").optional(),
  gender: z.enum(["male", "female", "other"]).optional(),
});

export const requestVirtualAccountSchema = z.object({
  preferredBank: z.string().trim().min(2).max(80).optional(),
});

export const requestWithdrawalSchema = z.object({
  amountMinor: z.number().int().positive(),
  bankCode,
  accountNumber,
  accountName: z.string().trim().min(2).max(255),
  idempotencyKey: z.string().trim().min(8).max(80),
});

export const finalizeWithdrawalSchema = z.object({
  transferCode: z.string().trim().min(4).max(120),
  otp: z.string().trim().min(4).max(20),
});

export const resolveBankAccountQuerySchema = z.object({
  accountNumber,
  bankCode,
});

export const listWalletTransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});
