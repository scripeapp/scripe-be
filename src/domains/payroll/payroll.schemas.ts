/**
 * Zod request/response contracts for the payroll domain. Amounts are accepted
 * as non-negative integer strings of minor units and parsed to bigint in the
 * controller before reaching the service.
 */
import { z } from "zod";

export const businessParamsSchema = z.object({
  businessId: z.string().uuid(),
});

export const runParamsSchema = z.object({
  businessId: z.string().uuid(),
  runId: z.string().uuid(),
});

export const listRunsQuerySchema = z.object({
  status: z.enum(["draft", "approved", "processing", "paid", "partially_paid", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const positiveMinor = z.string().regex(/^[0-9]+$/, "must be an integer of minor units").refine((v) => BigInt(v) > 0n, "must be greater than zero");
const nonNegativeMinor = z.string().regex(/^[0-9]+$/, "must be an integer of minor units");

export const createRunSchema = z
  .object({
    periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodStart must be YYYY-MM-DD"),
    periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "periodEnd must be YYYY-MM-DD"),
    items: z
      .array(
        z.object({
          beneficiaryId: z.string().uuid(),
          partyId: z.string().uuid().optional(),
          grossMinor: positiveMinor,
          deductionsMinor: nonNegativeMinor.default("0"),
        }),
      )
      .min(1, "a payroll run needs at least one item"),
  })
  .refine((run) => run.periodEnd >= run.periodStart, { message: "periodEnd must be on or after periodStart", path: ["periodEnd"] })
  .refine(
    (run) => run.items.every((item) => BigInt(item.deductionsMinor) <= BigInt(item.grossMinor)),
    { message: "deductionsMinor cannot exceed grossMinor", path: ["items"] },
  );

export type CreateRunBody = z.infer<typeof createRunSchema>;
