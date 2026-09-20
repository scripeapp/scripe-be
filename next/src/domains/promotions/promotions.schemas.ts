import { z } from "zod";

export const businessParamsSchema = z.object({ businessId: z.string().uuid() });

export const discountParamsSchema = businessParamsSchema.extend({
  discountId: z.string().uuid(),
});

const minorAmount = z.string().regex(/^[1-9][0-9]*$/, "Must be a positive integer amount in minor units");

const discountCreateBase = z.object({
  kind: z.enum(["code", "automatic"]),
  name: z.string().trim().min(1).max(100),
  code: z.string().trim().min(1).max(50).toUpperCase().nullable().optional(),
  type: z.enum(["percentage", "fixed"]),
  percentageBps: z.number().int().min(1).max(10000).nullable().optional(),
  fixedAmountMinor: minorAmount.nullable().optional(),
  isActive: z.boolean().optional(),
  maxUsage: z.number().int().positive().nullable().optional(),
  oneUsePerCustomer: z.boolean().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  appliesTo: z.enum(["all", "specific_products"]).optional(),
  productIds: z.array(z.string().uuid()).max(200).optional(),
  trigger: z.enum(["spend_threshold", "quantity_bought", "specific_products", "first_order"]).nullable().optional(),
  triggerSpendMinor: minorAmount.nullable().optional(),
  triggerQuantity: z.number().int().positive().nullable().optional(),
  qualificationProductIds: z.array(z.string().uuid()).max(200).optional(),
  allowCodeOnTop: z.boolean().optional(),
  showOnStorefront: z.boolean().optional(),
});

function refineDiscountFields<T extends z.infer<typeof discountCreateBase>>(value: T, context: z.RefinementCtx): void {
  if (value.kind === "code" && !value.code) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "A code is required for kind='code'" });
  }
  if (value.kind === "automatic" && !value.trigger) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["trigger"], message: "A trigger is required for kind='automatic'" });
  }
  if (value.type === "percentage" && value.percentageBps == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["percentageBps"], message: "percentageBps is required for type='percentage'" });
  }
  if (value.type === "fixed" && value.fixedAmountMinor == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["fixedAmountMinor"], message: "fixedAmountMinor is required for type='fixed'" });
  }
  if (value.appliesTo === "specific_products" && !value.productIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["productIds"], message: "productIds is required when appliesTo='specific_products'" });
  }
  if (value.trigger === "spend_threshold" && value.triggerSpendMinor == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggerSpendMinor"], message: "triggerSpendMinor is required for the spend_threshold trigger" });
  }
  if (value.trigger === "quantity_bought" && value.triggerQuantity == null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["triggerQuantity"], message: "triggerQuantity is required for the quantity_bought trigger" });
  }
  if (value.trigger === "specific_products" && !value.qualificationProductIds?.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["qualificationProductIds"], message: "qualificationProductIds is required for the specific_products trigger" });
  }
}

export const createDiscountSchema = discountCreateBase.superRefine(refineDiscountFields);

export const updateDiscountSchema = discountCreateBase
  .omit({ kind: true, type: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, "At least one field is required");

export const evaluateSchema = z.object({
  items: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.number().int().positive(),
    lineTotalMinor: minorAmount,
  })).min(1),
  customerPartyId: z.string().uuid().nullable().optional(),
  code: z.string().trim().min(1).max(50).nullable().optional(),
});
