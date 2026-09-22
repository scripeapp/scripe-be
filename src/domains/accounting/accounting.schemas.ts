import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const journalEntryParamsSchema = businessParamsSchema.extend({ journalEntryId: z.string().uuid() });

export const periodParamsSchema = businessParamsSchema.extend({ periodId: z.string().uuid() });

export const listJournalEntriesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).optional(),
});

export const setPeriodStatusSchema = z.object({
  status: z.enum(["open", "closing", "locked"]),
});
