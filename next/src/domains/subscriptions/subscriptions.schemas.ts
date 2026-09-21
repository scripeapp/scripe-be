import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const initiateSubscriptionSchema = z.object({
  plan: z.enum(["plus", "pro"]),
  callbackUrl: z.string().url().optional(),
});
