import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });
export const methodParamsSchema = businessParamsSchema.extend({ methodId: z.string().uuid() });
export const zoneParamsSchema = businessParamsSchema.extend({ zoneId: z.string().uuid() });
export const deliveryParamsSchema = businessParamsSchema.extend({ deliveryId: z.string().uuid() });

export const listMethodsQuerySchema = z.object({ storeId: z.string().uuid().optional() });
export const createMethodSchema = z.object({
  storeId: z.string().uuid(),
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(2000).optional(),
  priceMinor: z.number().int().min(0).optional(),
  estimatedTime: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).optional(),
});
export const updateMethodSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().max(2000).nullish(),
    priceMinor: z.number().int().min(0).optional(),
    estimatedTime: z.string().trim().max(100).nullish(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");
export const reorderMethodsSchema = z.object({ storeId: z.string().uuid(), order: z.array(z.string().uuid()).min(1).max(100) });
export const setCarrierDeliverySchema = z.object({ storeId: z.string().uuid(), enabled: z.boolean() });

export const listZonesQuerySchema = z.object({ storeId: z.string().uuid().optional() });
export const createZoneSchema = z.object({
  storeId: z.string().uuid(),
  locationId: z.string().uuid(),
  zipCode: z.string().trim().min(1).max(60),
  feeMinor: z.number().int().min(0).optional(),
  minOrderMinor: z.number().int().min(0).optional(),
  estimatedMinutes: z.number().int().positive().optional(),
  isActive: z.boolean().optional(),
});
export const updateZoneSchema = z
  .object({
    zipCode: z.string().trim().min(1).max(60).optional(),
    feeMinor: z.number().int().min(0).optional(),
    minOrderMinor: z.number().int().min(0).nullish(),
    estimatedMinutes: z.number().int().positive().nullish(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), "At least one field is required");
export const matchZoneQuerySchema = z.object({ storeId: z.string().uuid(), locationId: z.string().uuid(), zipCode: z.string().trim().min(1).max(60) });
export const listDeliveriesQuerySchema = z.object({ orderId: z.string().uuid() });

const parcelSchema = z.object({
  name: z.string().trim().max(150).optional(),
  quantity: z.number().int().positive(),
  weight: z.number().positive(),
  declaredValueMinor: z.number().int().min(0).optional(),
});

const carrierAddressSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(30),
  email: z.string().trim().email().optional(),
  addressLine1: z.string().trim().min(1).max(300),
  city: z.string().trim().min(1).max(150),
  state: z.string().trim().min(1).max(150),
  countryCode: z.string().trim().length(2).optional(),
  postalCode: z.string().trim().max(60).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

export const getRatesSchema = z.object({
  storeId: z.string().uuid(),
  parcels: z.array(parcelSchema).min(1).max(50),
}).and(carrierAddressSchema);

export const createShipmentSchema = z.object({
  orderId: z.string().uuid(),
  fulfillmentId: z.string().uuid().optional(),
  storeId: z.string().uuid(),
  destination: carrierAddressSchema,
  parcels: z.array(parcelSchema).min(1).max(50),
  serviceCode: z.string().trim().min(1),
  courierId: z.string().trim().min(1),
  rate: z.object({
    provider: z.literal("shipbubble"),
    serviceName: z.string(),
    serviceCode: z.string(),
    courierId: z.string(),
    priceMinor: z.number().int().min(0),
    currency: z.string(),
    estimatedTime: z.string(),
    description: z.string().optional(),
  }),
});
