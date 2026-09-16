import { z } from "zod";

const businessId = z.string().uuid();
const pin = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");

export const pinSchemas = {
  setPin: z.object({
    business_id: businessId,
    pin,
    current_pin: pin.optional(),
  }),
};

export type SetPinInput = z.infer<typeof pinSchemas.setPin>;