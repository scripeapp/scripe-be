import { z } from "zod";

export const checkinSchemas = {
  authenticateWithCode: z.object({
    event_id: z.string().uuid("Invalid event ID"),
    code: z
      .string()
      .min(1, "Access code is required")
      .max(20, "Invalid access code"),
  }),
};

export type CheckinAuthInput = z.infer<
  typeof checkinSchemas.authenticateWithCode
>;
