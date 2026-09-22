import { z } from "zod";

const uuid = z.string().uuid();
const nullableText = z.string().trim().max(500).nullable().optional();
// Money crosses JSON boundaries as a decimal string so bigint values never pass
// through JavaScript floating-point numbers.
const moneyMinor = z.string().regex(/^(?:0|[1-9]\d*)$/);

export const businessParamsSchema = z.object({ businessId: uuid });
export const storeParamsSchema = z.object({ businessId: uuid, storeId: uuid });
export const childParamsSchema = storeParamsSchema.extend({ childId: uuid });
export const registerParamsSchema = storeParamsSchema.extend({ registerId: uuid });
export const shiftParamsSchema = storeParamsSchema.extend({ shiftId: uuid });

export const createStoreSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().trim().min(2).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().trim().max(2000).default(""),
  isDefault: z.boolean().default(false),
  sellsOnline: z.boolean().default(true),
  sellsInPerson: z.boolean().default(false),
  contactEmail: z.string().trim().email().max(320).nullable().optional(),
  contactPhone: nullableText,
  timezone: z.string().trim().min(1).max(100).default("Africa/Lagos"),
});

export const updateStoreSchema = createStoreSchema.partial().extend({
  status: z.enum(["draft", "active"]).optional(),
}).refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const locationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["branch", "warehouse", "kitchen", "pharmacy", "stockroom"]).default("branch"),
  status: z.enum(["active", "inactive"]).default("active"),
  isDefault: z.boolean().default(false),
  addressLine1: nullableText,
  addressLine2: nullableText,
  city: nullableText,
  state: nullableText,
  postalCode: nullableText,
  countryCode: z.string().trim().length(2).transform((value) => value.toUpperCase()).default("NG"),
  latitude: z.string().regex(/^-?(?:\d|[1-8]\d|90)(?:\.\d{1,6})?$/).nullable().optional(),
  longitude: z.string().regex(/^-?(?:\d{1,2}|1[0-7]\d|180)(?:\.\d{1,6})?$/).nullable().optional(),
  phone: nullableText,
  timezone: z.string().trim().min(1).max(100).default("Africa/Lagos"),
  businessHours: z.record(z.unknown()).default({}),
  prepTimeMinutes: z.number().int().min(0).max(1440).nullable().optional(),
});
export const updateLocationSchema = locationSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const channelSchema = z.object({
  code: z.string().trim().min(2).max(40).regex(/^[a-z][a-z0-9_]+$/),
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["storefront", "pos", "manual_invoice", "qr", "other"]),
  status: z.enum(["active", "paused"]).default("active"),
});
export const updateChannelSchema = channelSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const registerSchema = z.object({
  locationId: uuid,
  name: z.string().trim().min(1).max(100),
  status: z.enum(["active", "inactive"]).default("active"),
});
export const updateRegisterSchema = registerSchema.partial().refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const openShiftSchema = z.object({
  openingCashMinor: moneyMinor.default("0"),
});

export const closeShiftSchema = z.object({
  countedCashMinor: moneyMinor,
  notes: z.string().trim().max(1000).optional(),
});

export const cashMovementSchema = z.object({
  // Adjustment direction is not approved yet. Keep it out of the HTTP
  // contract rather than silently treating every adjustment as cash-in.
  type: z.enum(["cash_in", "cash_out", "safe_drop"]),
  amountMinor: z.string().regex(/^[1-9]\d*$/),
  reason: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(8).max(200),
});

const timestamp = z.string().datetime();
const nullableTimestamp = timestamp.nullable();
const storeResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  status: z.enum(["draft", "active", "archived"]),
  isDefault: z.boolean(),
  sellsOnline: z.boolean(),
  sellsInPerson: z.boolean(),
  contactEmail: z.string().nullable(),
  contactPhone: z.string().nullable(),
  timezone: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: nullableTimestamp,
});
const locationResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  storeId: uuid,
  name: z.string(),
  kind: z.enum(["branch", "warehouse", "kitchen", "pharmacy", "stockroom"]),
  status: z.enum(["active", "inactive", "archived"]),
  isDefault: z.boolean(),
  addressLine1: z.string().nullable(),
  addressLine2: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  countryCode: z.string().length(2),
  latitude: z.string().nullable(),
  longitude: z.string().nullable(),
  phone: z.string().nullable(),
  timezone: z.string(),
  businessHours: z.record(z.unknown()),
  prepTimeMinutes: z.number().int().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: nullableTimestamp,
});
const channelResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  storeId: uuid,
  code: z.string(),
  name: z.string(),
  kind: z.enum(["storefront", "pos", "manual_invoice", "qr", "other"]),
  status: z.enum(["active", "paused", "archived"]),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const registerResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  storeId: uuid,
  locationId: uuid,
  name: z.string(),
  status: z.enum(["active", "inactive", "archived"]),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: nullableTimestamp,
});
const shiftResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  storeId: uuid,
  locationId: uuid,
  registerId: uuid,
  openedByMembershipId: uuid,
  closedByMembershipId: uuid.nullable(),
  openingCashMinor: z.string().regex(/^\d+$/),
  expectedCashMinor: z.string().regex(/^-?\d+$/).nullable(),
  countedCashMinor: z.string().regex(/^\d+$/).nullable(),
  varianceMinor: z.string().regex(/^-?\d+$/).nullable(),
  status: z.enum(["open", "closed"]),
  openedAt: timestamp,
  closedAt: nullableTimestamp,
  notes: z.string().nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
const cashMovementResponseSchema = z.object({
  id: uuid,
  businessId: uuid,
  storeId: uuid,
  locationId: uuid,
  registerId: uuid,
  shiftId: uuid,
  type: z.enum(["cash_in", "cash_out", "safe_drop", "adjustment"]),
  amountMinor: z.string().regex(/^\d+$/),
  reason: z.string(),
  actorMembershipId: uuid,
  requestId: z.string(),
  idempotencyKey: z.string(),
  occurredAt: timestamp,
  createdAt: timestamp,
});

export const storesResultSchema = z.object({ stores: z.array(storeResponseSchema) });
export const storeResultSchema = z.object({ store: storeResponseSchema });
export const locationsResultSchema = z.object({ locations: z.array(locationResponseSchema) });
export const locationResultSchema = z.object({ location: locationResponseSchema });
export const channelsResultSchema = z.object({ channels: z.array(channelResponseSchema) });
export const channelResultSchema = z.object({ channel: channelResponseSchema });
export const registersResultSchema = z.object({ registers: z.array(registerResponseSchema) });
export const registerResultSchema = z.object({ register: registerResponseSchema });
export const shiftResultSchema = z.object({ shift: shiftResponseSchema.nullable() });
export const cashMovementsResultSchema = z.object({ cashMovements: z.array(cashMovementResponseSchema) });
export const cashMovementResultSchema = z.object({ cashMovement: cashMovementResponseSchema });

export type CreateStoreRequest = z.infer<typeof createStoreSchema>;
export type UpdateStoreRequest = z.infer<typeof updateStoreSchema>;
export type CreateLocationRequest = z.infer<typeof locationSchema>;
export type UpdateLocationRequest = z.infer<typeof updateLocationSchema>;
export type CreateChannelRequest = z.infer<typeof channelSchema>;
export type UpdateChannelRequest = z.infer<typeof updateChannelSchema>;
export type CreateRegisterRequest = z.infer<typeof registerSchema>;
export type UpdateRegisterRequest = z.infer<typeof updateRegisterSchema>;
export type OpenShiftRequest = z.infer<typeof openShiftSchema>;
export type CloseShiftRequest = z.infer<typeof closeShiftSchema>;
export type CashMovementRequest = z.infer<typeof cashMovementSchema>;
