import { z } from "zod";

const entityTypeSchema = z.enum(["order", "payment", "refund", "transfer", "register_shift", "user", "business", "stock_adjustment"]);
const severitySchema = z.enum(["critical", "high", "medium", "low"]);
const signalStatusSchema = z.enum(["open", "investigating", "confirmed", "cleared"]);
const caseStatusSchema = z.enum(["open", "investigating", "resolved", "dismissed"]);
const holdEntityTypeSchema = z.enum(["business", "user"]);

export const signalParamsSchema = z.object({ signalId: z.string().uuid() });
export const listSignalsQuerySchema = z.object({
  status: signalStatusSchema.optional(),
  severity: severitySchema.optional(),
  entityType: entityTypeSchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
export const reviewSignalSchema = z.object({
  status: signalStatusSchema,
  notes: z.string().trim().max(2000).optional(),
});

export const caseParamsSchema = z.object({ caseId: z.string().uuid() });
export const listCasesQuerySchema = z.object({ status: caseStatusSchema.optional() });
export const createCaseSchema = z.object({
  title: z.string().trim().min(1).max(200),
  signalIds: z.array(z.string().uuid()).max(100).optional(),
});
export const updateCaseSchema = z
  .object({
    status: caseStatusSchema.optional(),
    assignedTo: z.string().uuid().nullish(),
    resolutionNotes: z.string().trim().max(2000).nullish(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");

export const holdParamsSchema = z.object({ holdId: z.string().uuid() });
export const listHoldsQuerySchema = z.object({ status: z.enum(["active", "released"]).optional() });
export const createHoldSchema = z.object({
  entityType: holdEntityTypeSchema,
  entityId: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
});
