import { z } from "zod";

export const updateGoogleCalendarSchema = z.object({ meetEnabled: z.boolean() });
