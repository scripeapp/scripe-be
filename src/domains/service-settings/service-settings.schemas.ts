import { z } from "zod";

const MINUTES_IN_DAY = 1440;
const MAX_ADVANCE_DAYS = 730;

export const serviceSettingsParamsSchema = z.object({
  businessId: z.string().uuid(),
  productId: z.string().uuid(),
});

export const depositRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({ kind: z.literal("fixed"), amountMinor: z.number().int().positive() }),
  z.object({ kind: z.literal("percent"), percent: z.number().int().min(1).max(100) }),
]);

export const upsertServiceSettingsSchema = z.object({
  durationMinutes: z.number().int().positive().max(MINUTES_IN_DAY),
  bufferBeforeMinutes: z.number().int().min(0).max(MINUTES_IN_DAY).default(0),
  bufferAfterMinutes: z.number().int().min(0).max(MINUTES_IN_DAY).default(0),
  minNoticeMinutes: z.number().int().min(0).max(MAX_ADVANCE_DAYS * MINUTES_IN_DAY).default(0),
  maxAdvanceDays: z.number().int().positive().max(MAX_ADVANCE_DAYS).default(60),
  slotIntervalMinutes: z.number().int().positive().max(MINUTES_IN_DAY).default(15),
  locationType: z.enum(["in_person", "at_customer", "online", "phone"]).default("in_person"),
  requiresApproval: z.boolean().default(false),
  depositRule: depositRuleSchema.default({ kind: "none" }),
  cancellationWindowMin: z.number().int().min(0).max(MAX_ADVANCE_DAYS * MINUTES_IN_DAY).default(MINUTES_IN_DAY),
});

export type UpsertServiceSettingsInput = z.infer<typeof upsertServiceSettingsSchema>;
export type DepositRule = z.infer<typeof depositRuleSchema>;
