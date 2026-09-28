import { z } from "zod";

const uuid = z.string().uuid();
const displayName = z.string().trim().min(1).max(160);
const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:mm");
const MINUTES_IN_DAY = 1440;

export const businessParamsSchema = z.object({ businessId: uuid });
export const staffParamsSchema = businessParamsSchema.extend({ staffId: uuid });
export const exceptionParamsSchema = businessParamsSchema.extend({ exceptionId: uuid });

export const createStaffSchema = z
  .object({
    membershipId: uuid.nullable().optional(),
    partyId: uuid.nullable().optional(),
    displayName,
    photoUploadId: uuid.nullable().optional(),
    isBookable: z.boolean().default(true),
  })
  .refine((value) => Boolean(value.membershipId || value.partyId), {
    message: "A staff member must link to a membership or a payroll party",
    path: ["membershipId"],
  });

export const updateStaffSchema = z
  .object({
    displayName: displayName.optional(),
    photoUploadId: uuid.nullable().optional(),
    isBookable: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const setStaffServicesSchema = z.object({
  services: z
    .array(
      z.object({
        productId: uuid,
        variantId: uuid.nullable().optional(),
        durationOverrideMinutes: z.number().int().positive().max(MINUTES_IN_DAY).nullable().optional(),
      }),
    )
    .max(500),
});

export const setStaffScheduleSchema = z.object({
  entries: z
    .array(
      z
        .object({
          locationId: uuid,
          weekday: z.number().int().min(0).max(6),
          startTime: timeOfDay,
          endTime: timeOfDay,
        })
        .refine((entry) => entry.startTime < entry.endTime, {
          message: "startTime must be before endTime",
          path: ["endTime"],
        }),
    )
    .max(200),
});

export const listExceptionsQuerySchema = z.object({ staffId: uuid.optional() });

export const createExceptionSchema = z
  .object({
    staffId: uuid.nullable().optional(),
    locationId: uuid.nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    kind: z.enum(["off", "extra"]),
    reason: z.string().trim().max(500).nullable().optional(),
  })
  .refine((value) => new Date(value.endsAt) > new Date(value.startsAt), {
    message: "endsAt must be after startsAt",
    path: ["endsAt"],
  });

export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type SetStaffServicesInput = z.infer<typeof setStaffServicesSchema>;
export type SetStaffScheduleInput = z.infer<typeof setStaffScheduleSchema>;
export type CreateExceptionInput = z.infer<typeof createExceptionSchema>;
