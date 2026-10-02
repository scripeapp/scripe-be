import { z } from "zod";

export const params = z.object({
  businessId: z.string().uuid(),
  invoiceId: z.string().uuid(),
});

export const businessParams = z.object({
  businessId: z.string().uuid(),
});

export const publicTokenParams = z.object({
  token: z.string().min(16),
});

const moneyInput = z.union([
  z.string().regex(/^\d+$/),
  z.number().int().nonnegative(),
  z.bigint().refine((b) => b >= 0n),
]);

export const invoiceLineSchema = z.object({
  description: z.string().trim().min(1).max(255),
  quantity: z.number().positive(),
  unitPriceMinor: moneyInput,
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  discountMinor: moneyInput.optional().default("0"),
  productVariantId: z.string().uuid().optional(),
  sortOrder: z.number().int().optional().default(0),
});

export const createInvoiceSchema = z.object({
  storeId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  customer: z
    .object({
      name: z.string().trim().min(1).max(160),
      email: z.string().trim().email(),
      phone: z.string().trim().optional(),
      address: z.string().trim().optional(),
      city: z.string().trim().optional(),
      state: z.string().trim().optional(),
    })
    .optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.string().regex(/^[A-Z]{3}$/).default("NGN"),
  discountMinor: moneyInput.optional().default("0"),
  notes: z.string().trim().max(1000).optional(),
  terms: z.string().trim().max(1000).optional(),
  lines: z.array(invoiceLineSchema).min(1),
}).refine((data) => data.customerPartyId || data.customer, {
  message: "Either customerPartyId or customer details must be provided",
});

export const updateInvoiceSchema = z.object({
  storeId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  customer: z
    .object({
      name: z.string().trim().min(1).max(160),
      email: z.string().trim().email(),
      phone: z.string().trim().optional(),
      address: z.string().trim().optional(),
      city: z.string().trim().optional(),
      state: z.string().trim().optional(),
    })
    .optional(),
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  discountMinor: moneyInput.optional(),
  notes: z.string().trim().max(1000).optional(),
  terms: z.string().trim().max(1000).optional(),
  lines: z.array(invoiceLineSchema).min(1).optional(),
});

export const listInvoicesQuery = z.object({
  status: z.enum(["draft", "pending", "partially_paid", "paid", "overdue", "void"]).optional(),
  customerId: z.string().uuid().optional(),
  search: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const sendInvoiceSchema = z.object({
  idempotencyKey: z.string().trim().optional(),
});

export const recordPaymentSchema = z.object({
  amountMinor: moneyInput,
  method: z.enum(["cash", "bank_transfer", "card", "online"]),
  externalReference: z.string().trim().optional(),
  notes: z.string().trim().max(500).optional(),
  idempotencyKey: z.string().trim().optional(),
});
