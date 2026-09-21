import { z } from "zod";

export const jobParamsSchema = z.object({ jobId: z.string().uuid() });
export const listJobsQuerySchema = z.object({
  type: z.string().trim().min(1).max(100).optional(),
  status: z.enum(["pending", "running", "succeeded", "failed", "cancelled"]).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});
