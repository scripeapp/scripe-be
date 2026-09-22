/**
 * Zod request/response contracts for the transfers domain. Parsed at the
 * controller boundary before anything reaches the service. Money is accepted
 * as a string of minor units and validated as a positive integer.
 */
import { z } from "zod";

export const businessParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const beneficiaryParamsSchema = z.object({
  businessId: z.string().uuid(),
  beneficiaryId: z.string().uuid(),
});

export const transferParamsSchema = z.object({
  businessId: z.string().uuid(),
  transferId: z.string().uuid(),
});

export const listTransfersQuerySchema = z.object({
  status: z.enum(["pending", "awaitingApproval", "processing", "success", "failed", "rejected"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const createBeneficiarySchema = z.object({
  kind: z.enum(["supplier", "employee", "owner", "general"]),
  bankCode: z.string().trim().min(1).max(20),
  accountNumber: z.string().trim().min(1).max(20),
  accountName: z.string().trim().min(1).max(160),
  partyId: z.string().uuid().optional(),
});

const amountMinorSchema = z
  .string()
  .regex(/^[0-9]+$/, "amountMinor must be a positive integer string of minor units")
  .refine((value) => BigInt(value) > 0n, "amountMinor must be greater than zero");

export const requestTransferSchema = z.object({
  beneficiaryId: z.string().uuid(),
  amountMinor: amountMinorSchema,
  purpose: z.enum(["withdrawal", "supplier_payment", "payroll", "general"]),
  idempotencyKey: z.string().trim().min(8).max(200),
  reason: z.string().trim().min(1).max(200).optional(),
});

export type CreateBeneficiaryBody = z.infer<typeof createBeneficiarySchema>;
export type RequestTransferBody = z.infer<typeof requestTransferSchema>;
