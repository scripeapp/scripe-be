import { z } from "zod";
import { SUPPORTED_CURRENCIES } from "../utils/payment/types";
import {
  StoreSettingsSchema,
  StoreSettingsUpdateSchema,
  ProductSchema,
  ProductBaseSchema,
  ProductUpdateSchema,
  OrderItemSchema,
  CustomerSchema,
  DiscountCodeBaseSchema,
  AvailabilityProfileSchema,
  BookingSlotSchema,
} from "./store";

/**
 * Comprehensive Zod schemas for all Store API endpoints
 * Used as validation middleware at route level
 */

/** Whether an ISO date-time (with offset) is strictly in the future. */
function isFuture(dateTimeString: string): boolean {
  return Date.parse(dateTimeString) > Date.now();
}

/** Input shape for a single modifier option, shared by the per-option endpoint
 * and the inline `options` array accepted on group create/update. */
const modifierOptionInputSchema = z.object({
  store_id: z.string().uuid("Invalid store ID"),
  name: z.string().min(1, "Option name is required").max(255),
  price_delta: z.number().optional(),
  is_available: z.boolean().optional(),
  is_default: z.boolean().optional(),
  position: z.number().int().optional(),
  branch_ids: z.array(z.string().uuid()).nullable().optional(),
});

export const storeSchemas = {
  // ============================================================================
  // Store Management
  // ============================================================================

  initStore: z.object({
    user_id: z.string(),
    name: z
      .string()
      .min(1, "Store name is required")
      .max(255, "Store name too long"),
    slug: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        "Slug must contain only lowercase letters, numbers, and hyphens",
      )
      .min(1, "Slug is required")
      .max(255, "Slug too long"),
    registered_business_name: z.string().max(255).optional(),
  }),

  saveStore: StoreSettingsUpdateSchema.extend({
    store_id: z.string().uuid("Invalid store ID"),
  }).omit({
    id: true,
    user_id: true,
    created_at: true,
    updated_at: true,
  }),

  publishStore: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    is_live: z.boolean(),
    slug: z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        "Slug must contain only lowercase letters, numbers, and hyphens",
      )
      .optional(),
  }),

  deleteStore: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  getStoreSubaccount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  updateStoreSubaccount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    paystack_subaccount_code: z.string().nullable().optional(),
  }),

  // ============================================================================
  // Product Management
  // ============================================================================

  addProduct: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    product: ProductBaseSchema.omit({
      id: true,
      store_id: true,
      created_at: true,
      updated_at: true,
      orders_count: true,
    }).extend({
      category_ids: z
        .array(z.string().uuid("Invalid category ID"))
        .optional()
        .default([]),
    }),
  }),

  updateProduct: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    product_id: z.string().uuid("Invalid product ID"),
    updates: ProductUpdateSchema.omit({
      id: true,
      store_id: true,
      created_at: true,
      updated_at: true,
    }).extend({
      category_ids: z
        .array(z.string().uuid("Invalid category ID"))
        .nullable()
        .optional(),
    }),
  }),

  deleteProduct: z.object({
    productId: z.string().uuid("Invalid product ID"),
  }),

  listSuppliers: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    active_only: z.enum(["true", "false"]).optional(),
  }),

  createSupplier: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().trim().min(1).max(255),
    code: z.string().trim().max(80).nullable().optional(),
    contact_person: z.string().trim().max(255).optional(),
    email: z.string().trim().email().or(z.literal("")).optional(),
    phone: z.string().trim().max(80).optional(),
    category: z.string().trim().max(255).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    country: z.string().trim().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    payment_terms: z.string().trim().max(120).optional(),
    bank_name: z.string().trim().max(255).nullable().optional(),
    bank_code: z.string().trim().max(20).nullable().optional(),
    account_number: z.string().trim().max(80).nullable().optional(),
    account_name: z.string().trim().max(255).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  updateSupplier: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().trim().min(1).max(255).optional(),
    code: z.string().trim().max(80).nullable().optional(),
    contact_person: z.string().trim().max(255).optional(),
    email: z.string().trim().email().or(z.literal("")).optional(),
    phone: z.string().trim().max(80).optional(),
    category: z.string().trim().max(255).optional(),
    address: z.string().trim().max(500).nullable().optional(),
    city: z.string().trim().max(120).nullable().optional(),
    state: z.string().trim().max(120).nullable().optional(),
    country: z.string().trim().max(120).nullable().optional(),
    website: z.string().url().nullable().optional(),
    payment_terms: z.string().trim().max(120).optional(),
    bank_name: z.string().trim().max(255).nullable().optional(),
    bank_code: z.string().trim().max(20).nullable().optional(),
    account_number: z.string().trim().max(80).nullable().optional(),
    account_name: z.string().trim().max(255).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  supplierIdParam: z.object({
    supplierId: z.string().uuid("Invalid supplier ID"),
  }),

  supplierProductParam: z.object({
    supplierId: z.string().uuid("Invalid supplier ID"),
    supplierProductId: z.string().uuid("Invalid supplier product ID"),
  }),

  createSupplierProduct: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    product_id: z.string().uuid("Invalid product ID"),
    variant_id: z.string().uuid("Invalid variant ID").nullable().optional(),
    supplier_sku: z.string().trim().max(120).nullable().optional(),
    supplier_product_name: z.string().trim().max(255).nullable().optional(),
    unit_cost: z.number().nonnegative().nullable().optional(),
    minimum_order_quantity: z.number().int().positive().default(1),
    lead_time_days: z.number().int().nonnegative().nullable().optional(),
    is_preferred: z.boolean().default(false),
    status: z.enum(["active", "inactive"]).default("active"),
  }),

  updateSupplierProduct: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    supplier_sku: z.string().trim().max(120).nullable().optional(),
    supplier_product_name: z.string().trim().max(255).nullable().optional(),
    unit_cost: z.number().nonnegative().nullable().optional(),
    minimum_order_quantity: z.number().int().positive().optional(),
    lead_time_days: z.number().int().nonnegative().nullable().optional(),
    is_preferred: z.boolean().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),

  createStockReceipt: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
    received_at: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    purchase_order_id: z.string().uuid("Invalid purchase order ID").nullable().optional(),
    lines: z.array(z.object({
      product_id: z.string().uuid("Invalid product ID").nullable().optional(),
      variant_id: z.string().uuid("Invalid variant ID").nullable().optional(),
      purchase_order_line_id: z.string().uuid("Invalid purchase order line ID").nullable().optional(),
      description: z.string().trim().max(500).nullable().optional(),
      quantity_received: z.number().int().nonnegative(),
      quantity_rejected: z.number().int().nonnegative().default(0),
      rejection_reason: z.enum(["damaged", "wrong_item", "short_shipped", "expired_on_arrival", "other"]).nullable().optional(),
      unit_cost: z.number().nonnegative(),
      tax_rate: z.number().nonnegative().default(0),
      discount: z.number().nonnegative().default(0),
      batch_number: z.string().trim().max(120).nullable().optional(),
      expiry_date: z.string().date().nullable().optional(),
      manufacture_date: z.string().date().nullable().optional(),
      serial_number: z.string().trim().max(255).nullable().optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }).superRefine((line, context) => {
      if (!line.product_id && !line.description) {
        context.addIssue({ code: "custom", message: "A product or description is required" });
      }
      if (line.quantity_received === 0 && line.quantity_rejected === 0) {
        context.addIssue({ code: "custom", message: "A received or rejected quantity is required" });
      }
      if (line.quantity_rejected > 0 && !line.rejection_reason) {
        context.addIssue({ code: "custom", message: "A rejection reason is required" });
      }
    })).min(1).max(100),
  }),

  purchaseOrderParam: z.object({ purchaseOrderId: z.string().uuid("Invalid purchase order ID") }),
  createPurchaseOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    supplier_id: z.string().uuid("Invalid supplier ID"),
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
    order_date: z.string().date().optional(),
    expected_delivery_date: z.string().date().nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    lines: z.array(z.object({
      product_id: z.string().uuid().nullable().optional(),
      variant_id: z.string().uuid().nullable().optional(),
      description: z.string().trim().max(500).nullable().optional(),
      quantity_ordered: z.number().int().positive(),
      unit_cost: z.number().nonnegative(),
      tax_rate: z.number().nonnegative().default(0),
      discount: z.number().nonnegative().default(0),
      notes: z.string().trim().max(2000).nullable().optional(),
    }).superRefine((line, ctx) => {
      if (!line.product_id && !line.description) ctx.addIssue({ code: "custom", message: "A product or description is required" });
    })).min(1).max(100),
  }),
  updatePurchaseOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    // "sent" isn't settable here — POST .../send owns that transition,
    // since it also has to email the supplier.
    status: z.enum(["draft", "cancelled"]).optional(),
    expected_delivery_date: z.string().date().nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
  }),
  sendPurchaseOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),
  listPurchaseOrders: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    status: z.enum(["draft", "sent", "partially_received", "received", "cancelled"]).optional(),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
  }),

  listStockReceipts: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
  }),

  supplierBillParam: z.object({
    supplierId: z.string().uuid("Invalid supplier ID"),
    billId: z.string().uuid("Invalid bill ID"),
  }),

  createSupplierBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    bill_number: z.string().trim().min(1).max(120),
    invoice_number: z.string().trim().max(120).nullable().optional(),
    amount: z.number().positive(),
    currency: z.string().length(3).default("NGN"),
    issue_date: z.string().date(),
    due_date: z.string().date().nullable().optional(),
    status: z.enum(["draft", "pending", "approved", "overdue", "disputed", "cancelled"]).default("pending"),
    items_count: z.number().int().min(0).default(0),
    notes: z.string().trim().max(5000).nullable().optional(),
  }),

  updateSupplierBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    status: z.enum(["draft", "pending", "approved", "overdue", "disputed", "cancelled"]),
  }),

  listSupplierBills: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
  }),

  supplierBillItemsParams: z.object({
    supplierId: z.string().uuid("Invalid supplier ID"),
    billId: z.string().uuid("Invalid bill ID"),
  }),

  addSupplierBillItem: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    description: z.string().trim().min(1).max(500),
    quantity: z.number().int().positive().default(1),
    unit_price: z.number().nonnegative().default(0),
  }),

  listSupplierPayments: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
  }),

  createSupplierPayment: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    bill_id: z.string().uuid("Invalid bill ID").nullable().optional(),
    amount: z.number().positive(),
    payment_date: z.string().date().optional(),
    method: z.enum(["bank_transfer", "cash", "card", "online", "cheque"]).default("bank_transfer"),
    reference: z.string().trim().max(200).nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    status: z.enum(["pending", "successful", "failed"]).default("successful"),
  }),

  // ==========================================================================
  // Store-wide bills dashboard (Payments > Bill pay) — distinct from the
  // supplier-scoped /suppliers/:supplierId/bills endpoints above, which back
  // the Vendor detail page. This lists/creates bills across every vendor.
  // ==========================================================================

  billCategory: z.enum([
    "Inventory", "Software", "Logistics", "Utilities", "Marketing", "Rent",
    "Consulting", "Subscriptions", "Operations", "Professional fees", "Other",
  ]),

  billIdParam: z.object({
    billId: z.string().uuid("Invalid bill ID"),
  }),

  listBills: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    status: z.enum(["draft", "pending", "approved", "partially_paid", "paid", "overdue", "disputed", "cancelled", "rejected"]).optional(),
    category: z.enum([
      "Inventory", "Software", "Logistics", "Utilities", "Marketing", "Rent",
      "Consulting", "Subscriptions", "Operations", "Professional fees", "Other",
    ]).optional(),
    supplier_id: z.string().uuid("Invalid supplier ID").optional(),
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(20),
  }),

  storeIdQuery: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    supplier_id: z.string().uuid("Invalid supplier ID"),
    bill_number: z.string().trim().min(1).max(120),
    invoice_number: z.string().trim().max(120).nullable().optional(),
    category: z.enum([
      "Inventory", "Software", "Logistics", "Utilities", "Marketing", "Rent",
      "Consulting", "Subscriptions", "Operations", "Professional fees", "Other",
    ]).default("Other"),
    currency: z.string().length(3).default("NGN"),
    issue_date: z.string().date(),
    due_date: z.string().date().nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    // false = save as draft, true = submit straight into the approval queue.
    submit: z.boolean().default(false),
    items: z.array(z.object({
      description: z.string().trim().min(1).max(500),
      quantity: z.number().int().positive().default(1),
      unit_price: z.number().nonnegative(),
      tax_rate: z.number().nonnegative().default(0),
    })).min(1).max(200),
  }),

  approveBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  rejectBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    reason: z.string().trim().max(1000).nullable().optional(),
  }),

  payBill: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  updateInventory: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    updates: z.array(z.object({
      product_id: z.string().uuid("Invalid product ID"),
      variant_id: z.string().uuid("Invalid variant ID").optional(),
      branch_id: z.string().uuid("Invalid branch ID").optional(),
      quantity_change: z.number().int().refine((value) => value !== 0, "Quantity change cannot be zero"),
      reason: z
        .enum([
          "sale",
          "return",
          "restock",
          "received",
          "damaged",
          "spoilage",
          "expired",
          "theft",
          "shrinkage",
          "found",
          "count",
          "transfer_out",
          "transfer_in",
          "adjustment",
        ])
        .default("adjustment"),
      unit_cost: z.number().nonnegative().optional(),
      batch_number: z.string().trim().max(120).nullable().optional(),
      expiry_date: z.string().date().nullable().optional(),
      effective_at: z
        .string()
        .datetime({ offset: true })
        .refine((value) => !isFuture(value), "Effective date cannot be in the future")
        .optional(),
      notes: z.string().trim().max(2000).optional(),
    })).min(1),
  }),

  productDashboard: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Stock transfers (branch → branch)
  // ============================================================================

  createStockTransfer: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    reference: z.string().trim().min(1).max(40).optional(),
    from_branch_id: z.string().uuid("Invalid source branch ID"),
    to_branch_id: z.string().uuid("Invalid destination branch ID"),
    expected_at: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().max(2000).optional(),
    lines: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z.string().uuid("Invalid variant ID").optional(),
          quantity: z.number().int().positive("Quantity must be positive"),
          unit_cost: z.number().nonnegative().nullable().optional(),
          received_quantity: z
            .number()
            .int()
            .nonnegative()
            .default(0)
            .optional(),
        }),
      )
      .min(1),
  }),

  listStockTransfers: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(10),
  }),

  stockTransferIdParams: z.object({
    id: z.string().uuid("Invalid transfer ID"),
  }),

  getStockTransfer: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  sendStockTransfer: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  receiveStockTransfer: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    lines: z.array(
      z.object({
        product_id: z.string().uuid("Invalid product ID"),
        variant_id: z.string().uuid("Invalid variant ID").optional(),
        received_quantity: z
          .number()
          .int()
          .nonnegative(),
      }),
    ).min(1),
  }),

  cancelStockTransfer: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Stock counts (cycle counts)
  // ============================================================================

  createStockCount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    reference: z.string().trim().min(1).max(40).optional(),
    branch_id: z.string().uuid("Invalid branch ID"),
    scope: z.enum(["all", "selected"]).default("all"),
    count_date: z.string().datetime({ offset: true }).optional(),
    lines: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z.string().uuid("Invalid variant ID").optional(),
          counted_quantity: z
            .number()
            .int()
            .nonnegative("Counted quantity cannot be negative"),
        }),
      )
      .min(1),
  }),

  listStockCounts: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.coerce.number().int().positive().default(1),
    page_size: z.coerce.number().int().positive().max(100).default(10),
  }),

  stockCountIdParams: z.object({
    id: z.string().uuid("Invalid count ID"),
  }),

  getStockCount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  addStockCountLine: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    product_id: z.string().uuid("Invalid product ID"),
    variant_id: z.string().uuid("Invalid variant ID").optional(),
    counted_quantity: z
      .number()
      .int()
      .nonnegative("Counted quantity cannot be negative"),
  }),

  applyStockCount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  cancelStockCount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Branch Overrides (branch catalog + normalized branch inventory)
  // ============================================================================

  getProductBranchOverrides: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  upsertProductBranchOverrides: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    overrides: z.array(
      z.object({
        branch_id: z.string().uuid("Invalid branch ID"),
        is_available: z.boolean().default(true),
        price: z.number().nonnegative().nullable().optional(),
        currency_prices: z
          .record(
            z.string().length(3),
            z.object({
              price: z.number().positive(),
              compare_at_price: z.number().positive().nullable().optional(),
            }),
          )
          .nullable()
          .optional(),
        // Column exists (20260725_branch_lead_time_override.sql) and the
        // service already maps it (`lead_time_hours: o.lead_time_hours ??
        // null`), but this schema never let it through — Zod strips
        // unknown keys by default, so every lead-time override silently
        // saved as null.
        lead_time_hours: z.number().int().min(0).nullable().optional(),
        // Omitted = inherit global stock; explicit null = unlimited.
        stock_quantity: z.number().int().min(0).nullable().optional(),
        reserved_quantity: z.number().int().min(0).optional(),
        variant_stock: z
          .record(z.string().uuid(), z.number().int().min(0).nullable())
          .optional(),
      }),
    ),
  }),

  // ============================================================================
  // Order Management
  // ============================================================================

  createOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    payment_reference: z.string().min(1, "Payment reference is required"),
    customer: CustomerSchema,
    items: z.array(OrderItemSchema).min(1, "At least one item is required"),
    discount_code: z.string().optional(),
    delivery_method_id: z
      .string()
      .uuid("Invalid delivery method ID")
      .optional(),
    delivery_fee: z.number().int().min(0).optional(),
    delivery_provider: z.string().optional(),
    delivery_service_code: z.string().optional(),
    delivery_courier_id: z.string().optional(),
  }),

  // Merchant manual order creation
  createManualOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    customer: CustomerSchema,
    items: z.array(OrderItemSchema).min(1, "At least one item is required"),
    notes: z.string().optional(),
    mark_as_paid: z.boolean().default(true),
    payment_method: z.enum(["cash", "card", "transfer", "online"]).default("online"),
    branch_id: z.string().uuid().optional(),
    fulfillment_type: z.enum(["dine_in", "pickup", "delivery", "curbside"]).optional(),
  }),

  // Registers — named till devices
  listRegisters: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),

  // Store analytics — branch_id narrows to one branch; omitted, a
  // multi-branch store also gets a per-branch `locations` breakdown.
  getStoreAnalytics: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
  }),

  createRegister: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Name is required").max(120),
    // Nullable, not just optional — "Unassigned — pair later" is a real,
    // intentional choice in the Add Register form, which sends an
    // explicit `null` rather than omitting the field.
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
    device_type: z.enum(["web", "android", "ios", "pos_terminal"]).optional(),
  }),

  updateRegister: z.object({
    name: z.string().min(1).max(120).optional(),
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
    device_type: z.enum(["web", "android", "ios", "pos_terminal"]).nullable().optional(),
    status: z.enum(["active", "inactive"]).optional(),
  }),

  registerIdParam: z.object({
    registerId: z.string().uuid("Invalid register ID"),
  }),

  // Device pairing (registers-prd-full.md Phase 4b) — no dashboard auth
  pairRegisterDevice: z.object({
    pairing_code: z.string().length(16, "Pairing code must be 16 digits"),
  }),

  // Staff PINs (registers-prd-full.md Phase 5)
  listPosStaff: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createPosStaff: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Name is required").max(120),
    pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
    user_id: z.string().uuid("Invalid team member").optional(),
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
  }),

  updatePosStaff: z.object({
    name: z.string().min(1).max(120).optional(),
    pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits").optional(),
    status: z.enum(["active", "inactive"]).optional(),
    branch_id: z.string().uuid("Invalid branch ID").nullable().optional(),
  }),

  staffIdParam: z.object({
    staffId: z.string().uuid("Invalid staff ID"),
  }),

  // Device-auth only — no store_id in the body, resolved from the token.
  verifyPosStaffPin: z.object({
    pin: z.string().regex(/^\d{4}$/, "PIN must be 4 digits"),
    // Present only for the per-sale/close-shift re-prompts, which must
    // re-confirm the SAME staff member already active on this till rather
    // than accept any active staff member's PIN.
    expected_staff_id: z.string().uuid("Invalid staff ID").optional(),
  }),

  // Register (POS till) shifts
  openRegisterShift: z.object({
    register_id: z.string().uuid("Invalid register ID"),
    starting_float: z.number().int().min(0, "Starting float can't be negative"),
    staff_id: z.string().uuid("Invalid staff ID").optional(),
  }),

  closeRegisterShift: z.object({
    shift_id: z.string().uuid("Invalid shift ID"),
    counted_cash: z.number().int().min(0, "Counted cash can't be negative"),
    notes: z.string().max(1000).optional(),
    staff_id: z.string().uuid("Invalid staff ID").optional(),
  }),

  getCurrentRegisterShift: z.object({
    register_id: z.string().uuid("Invalid register ID"),
  }),

  shiftIdParam: z.object({
    shiftId: z.string().uuid("Invalid shift ID"),
  }),

  // POS ticket pricing preview — same item shape as createPosOrder, minus
  // payment/customer fields, so the cashier can see the real total before
  // charging without duplicating the pricing formula on the frontend.
  previewPosOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID"),
    fulfillment_type: z.enum(["dine_in", "pickup", "delivery", "curbside"]).optional(),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z.string().uuid("Invalid variant ID").nullable().optional(),
          quantity: z.number().int().positive("Quantity must be at least 1"),
          selected_modifiers: z
            .array(
              z.object({
                modifier_option_id: z.string().uuid("Invalid modifier option ID"),
                quantity: z.number().int().positive().optional(),
              }),
            )
            .optional(),
          note: z.string().max(500, "Note is too long").nullable().optional(),
          slot: BookingSlotSchema.nullable().optional(),
        }),
      )
      .min(1, "At least one item is required"),
    discount_code: z.string().optional(),
  }),

  // POS till sale — items mirror initiateCheckout's shape (no client price
  // field; the server derives it via resolveOrderItemPricing).
  createPosOrder: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID"),
    fulfillment_type: z.enum(["dine_in", "pickup", "delivery", "curbside"]).optional(),
    customer: z
      .object({
        name: z.string().min(1).optional(),
        email: z.string().email("Invalid email address").optional(),
        phone: z.string().optional(),
      })
      .optional(),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z.string().uuid("Invalid variant ID").nullable().optional(),
          quantity: z.number().int().positive("Quantity must be at least 1"),
          selected_modifiers: z
            .array(
              z.object({
                modifier_option_id: z.string().uuid("Invalid modifier option ID"),
                quantity: z.number().int().positive().optional(),
              }),
            )
            .optional(),
          note: z.string().max(500, "Note is too long").nullable().optional(),
          slot: BookingSlotSchema.nullable().optional(),
        }),
      )
      .min(1, "At least one item is required"),
    discount_code: z.string().optional(),
    payment_method: z.enum(["cash", "card", "transfer"], {
      message: "Invalid payment method",
    }),
    register_shift_id: z.string().uuid("Invalid shift ID").optional(),
    notes: z.string().max(1000, "Note is too long").optional(),
    staff_id: z.string().uuid("Invalid staff ID").optional(),
    // Client-generated per-attempt key so a network-drop retry (or a
    // cashier double-tapping "Complete sale") replays the same order
    // instead of double-charging/double-decrementing stock.
    idempotency_key: z.string().min(1).max(100).optional(),
  }),

  updateOrderStatus: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    order_id: z.string().uuid("Invalid order ID"),
    status: z.enum(
      ["pre_order", "paid", "processing", "fulfilled", "cancelled", "refunded"],
      {
        message: "Invalid order status",
      },
    ),
  }),

  updateOrderShipping: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    order_id: z.string().uuid("Invalid order ID"),
    updates: z.object({
      tracking_number: z.string().optional(),
      status: z
        .enum([
          "pending",
          "processing",
          "ready_for_pickup",
          "shipped",
          "delivered",
        ])
        .optional(),
      shipped_at: z.string().optional(),
      delivered_at: z.string().optional(),
    }),
  }),

  updateOrderNote: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    order_id: z.string().uuid("Invalid order ID"),
    note: z.string().min(1, "Note cannot be empty"),
  }),

  // ============================================================================
  // Discount Management
  // ============================================================================

  addDiscount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    code: DiscountCodeBaseSchema.omit({
      id: true,
      store_id: true,
      created_at: true,
      updated_at: true,
      usage_count: true,
    }),
  }),

  updateDiscount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    code_id: z.string().uuid("Invalid discount code ID"),
    updates: DiscountCodeBaseSchema.partial().omit({
      id: true,
      store_id: true,
      created_at: true,
      updated_at: true,
    }),
  }),

  deleteDiscount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    code_id: z.string().uuid("Invalid discount code ID"),
  }),

  validateDiscount: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    code: z.string().min(1, "Discount code is required"),
    subtotal: z.number().min(0).optional(),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid(),
          line_total: z.number().min(0),
        }),
      )
      .optional(),
  }).refine(
    (d) => d.items !== undefined || d.subtotal !== undefined,
    { message: "Provide items or subtotal" },
  ),

  discountApplicable: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    product_ids: z.array(z.string().uuid()).min(1),
  }),

  evaluateDiscounts: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    code: z.string().trim().min(1).max(50).optional(),
    customer_email: z.string().trim().email().optional(),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid(),
          quantity: z.number().int().positive(),
          line_total: z.number().min(0),
        }),
      )
      .min(1)
      .max(100),
  }),

  // ============================================================================
  // Data Retrieval
  // ============================================================================

  getProducts: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
    status: z.enum(["published", "draft"]).optional(),
    search: z.string().optional(),
    sort: z.string().optional(),
    category_id: z.string().uuid("Invalid category ID").optional(),
    menu_id: z.string().uuid("Invalid menu ID").optional(), // alias for parent_id filter
    uncategorized: z.enum(["true", "false"]).optional(),
    store_id: z.string().uuid("Invalid store ID"),
  }),

  getOrders: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
    status: z
      .enum(["pre_order", "paid", "processing", "fulfilled", "cancelled", "refunded"])
      .optional(),
    search: z.string().optional(),
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
    product_id: z.string().uuid("Invalid product ID").optional(),
  }),

  getDiscounts: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
    is_active: z.enum(["true", "false"]).optional(),
    kind: z.enum(["code", "automatic"]).optional(),
    search: z.string().trim().max(100).optional(),
    store_id: z.string().uuid("Invalid store ID"),
  }),

  getCustomers: z.object({
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
    search: z.string().optional(),
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Checkout
  // ============================================================================

  initiateCheckout: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    payment_reference: z.string().optional(),
    user_id: z.string().uuid().optional(), // For membership checkout
    selected_plan_id: z.string().uuid().optional(), // For allow_tier_selection memberships
    customer: z.object({
      name: z.string().min(1, "Customer name is required"),
      email: z.string().email("Invalid email address"),
      phone: z.string().optional(),
      address: z.string().optional(),
    }),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z
            .string()
            .uuid("Invalid variant ID")
            .nullable()
            .optional(),
          quantity: z.number().int().positive("Quantity must be at least 1"),
          price: z.number().min(0, "Price must be at least 0").optional(),
          slot: BookingSlotSchema.nullable().optional(),
          selected_modifiers: z
            .array(
              z.object({
                modifier_option_id: z.string().uuid("Invalid modifier option ID"),
                quantity: z.number().int().positive().optional(),
              }),
            )
            .optional(),
          note: z.string().max(500, "Note is too long").nullable().optional(),
        }),
      )
      .min(1, "At least one item is required"),
    discount_code: z.string().optional(),
    delivery_method_id: z
      .string()
      .uuid("Invalid delivery method ID")
      .optional(),
    delivery_fee: z.number().min(0).optional(),
    delivery_provider: z.string().optional(),
    delivery_service_code: z.string().optional(),
    delivery_courier_id: z.string().optional(),
    delivery_city: z.string().optional(),
    delivery_state: z.string().optional(),
    delivery_zip: z.string().max(20).optional(),
    callback_url: z.string().url("Invalid callback URL").optional(),
    currency: z.enum(SUPPORTED_CURRENCIES).optional(),
    // Food store fulfilment (PRD Phase 4)
    fulfillment_type: z.enum(["dine_in", "pickup", "delivery", "curbside"]).optional(),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
    utensils_requested: z.boolean().optional(),
    notes: z.string().max(1000, "Note is too long").optional(),
    // Opaque code from a scanned store QR — resolved server-side, overrides
    // branch_id and forces fulfillment_type to dine_in.
    qr_code: z.string().optional(),
  }),

  checkoutStatus: z.object({
    reference: z
      .string()
      .min(1, "Payment reference is required")
      .max(100, "Invalid payment reference"),
  }),

  freePurchase: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    customer: z.object({
      name: z.string().min(1, "Customer name is required"),
      email: z.string().email("Invalid email address"),
      phone: z.string().optional(),
      address: z.string().optional(),
    }),
    items: z
      .array(
        z.object({
          product_id: z.string().uuid("Invalid product ID"),
          variant_id: z
            .string()
            .uuid("Invalid variant ID")
            .nullable()
            .optional(),
          quantity: z.number().int().positive("Quantity must be at least 1"),
          price: z.number().min(0, "Price must be at least 0").optional(),
          slot: BookingSlotSchema.nullable().optional(),
          selected_modifiers: z
            .array(
              z.object({
                modifier_option_id: z.string().uuid("Invalid modifier option ID"),
                quantity: z.number().int().positive().optional(),
              }),
            )
            .optional(),
          note: z.string().max(500, "Note is too long").nullable().optional(),
        }),
      )
      .min(1, "At least one item is required"),
    discount_code: z.string().optional(),
    delivery_method_id: z
      .string()
      .uuid("Invalid delivery method ID")
      .optional(),
    delivery_fee: z.number().min(0).optional(),
    delivery_provider: z.string().optional(),
    delivery_service_code: z.string().optional(),
    delivery_courier_id: z.string().optional(),
    delivery_city: z.string().optional(),
    delivery_state: z.string().optional(),
    delivery_zip: z.string().max(20).optional(),
    fulfillment_type: z.enum(["dine_in", "pickup", "delivery", "curbside"]).optional(),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
    utensils_requested: z.boolean().optional(),
    notes: z.string().max(1000, "Note is too long").optional(),
  }),

  // ============================================================================
  // Category Management
  // ============================================================================

  getCategories: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    parent_id: z.string().uuid("Invalid menu/parent ID").optional(),
  }),

  createCategory: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z
      .string()
      .min(1, "Category name is required")
      .max(100, "Category name too long"),
    description: z.string().max(500, "Description too long").optional(),
    is_active: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    parent_id: z.string().uuid("Invalid menu/parent ID").nullable().optional(),
  }),

  updateCategory: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    is_active: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
    parent_id: z.string().uuid("Invalid menu/parent ID").nullable().optional(),
  }),

  deleteCategory: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  reorderCategories: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    orders: z
      .array(
        z.object({
          id: z.string().uuid("Invalid category ID"),
          position: z.number().int().min(0),
        }),
      )
      .min(1, "At least one category is required"),
  }),

  // ============================================================================
  // Delivery Methods Management
  // ============================================================================

  getDeliveryMethods: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createDeliveryMethod: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Name is required").max(255, "Name too long"),
    description: z
      .string()
      .max(1000, "Description too long")
      .nullable()
      .optional(),
    price: z.number().int().min(0, "Price must be >= 0").default(0),
    currency: z
      .string()
      .length(3, "Currency must be 3 characters")
      .default("NGN"),
    estimated_time: z
      .string()
      .max(100, "Estimated time too long")
      .nullable()
      .optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
  }),

  updateDeliveryMethod: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    price: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    estimated_time: z.string().max(100).nullable().optional(),
    is_active: z.boolean().optional(),
    sort_order: z.number().int().min(0).optional(),
  }),

  deleteDeliveryMethod: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  reorderDeliveryMethods: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    order: z
      .array(z.string().uuid("Invalid method ID"))
      .min(1, "At least one method required"),
  }),

  // ============================================================================
  // Delivery Zones (Branch-Aware Storefront) — zip-code-keyed fee/minimum
  // order/ETA tables per branch, alternative to the flat-rate methods above.
  // ============================================================================

  getDeliveryZones: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID").optional(),
  }),

  createDeliveryZone: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    branch_id: z.string().uuid("Invalid branch ID"),
    zip_code: z.string().min(1, "Zip code is required").max(20),
    fee: z.number().int().min(0, "Fee must be >= 0").default(0),
    currency: z.string().length(3).default("NGN"),
    min_order: z.number().int().min(0).nullable().optional(),
    estimated_minutes: z.number().int().min(0).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  updateDeliveryZone: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    zip_code: z.string().min(1).max(20).optional(),
    fee: z.number().int().min(0).optional(),
    currency: z.string().length(3).optional(),
    min_order: z.number().int().min(0).nullable().optional(),
    estimated_minutes: z.number().int().min(0).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  deleteDeliveryZone: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Delivery Rates (Shipbubble)
  // ============================================================================

  validateSenderAddress: z.object({
    name: z.string().optional(),
    address: z.string().min(3, "Address is required"),
    phone: z.string().optional(),
    email: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),

  setCarrierDelivery: z.object({
    store_id: z.string().uuid("Valid store_id is required"),
    enabled: z.boolean(),
  }),

  getPublicDeliveryRates: z.object({
    destination_city: z.string().min(1, "City is required"),
    destination_state: z.string().min(1, "State is required"),
    destination_country: z.string().optional().default("Nigeria"),
    destination_postal_code: z.string().optional(),
    destination_address: z.string().optional(),
    destination_lat: z.string().optional(),
    destination_lng: z.string().optional(),
    destination_name: z.string().optional(),
    destination_phone: z.string().optional(),
    destination_email: z.string().optional(),
    destination_address_code: z.string().optional(),
    total_weight: z.string().optional(),
    total_value: z.string().optional(),
  }),

  // ============================================================================
  // Shipbubble Webhook
  // ============================================================================

  shipbubbleWebhook: z.object({
    event: z.string(),
    order_id: z.string(),
    status: z.string(),
    courier: z
      .object({
        name: z.string().optional(),
        tracking_code: z.string().optional(),
        tracking_message: z.string().optional(),
      })
      .optional(),
    tracking_url: z.string().optional(),
    package_status: z
      .array(z.object({ status: z.string(), datetime: z.string() }))
      .optional(),
    events: z
      .array(
        z.object({ location: z.string(), message: z.string(), captured: z.string() }),
      )
      .optional(),
  }),

  // ============================================================================
  // Store Reviews
  // ============================================================================

  getPublicReviews: z.object({
    product_id: z.string().uuid().optional(),
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
  }),

  submitReview: z.object({
    product_id: z.string().uuid("Invalid product ID").nullable().optional(),
    customer_name: z
      .string()
      .min(1, "Name is required")
      .max(100, "Name too long"),
    customer_email: z.string().email("Invalid email"),
    rating: z
      .number()
      .int()
      .min(1, "Rating must be 1-5")
      .max(5, "Rating must be 1-5"),
    title: z.string().max(150, "Title too long").optional(),
    content: z.string().max(2000, "Content too long").optional(),
    order_id: z.string().uuid("Invalid order ID").optional(),
  }),

  getStoreReviews: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    page: z.string().optional().default("1"),
    limit: z.string().optional().default("10"),
  }),

  updateReviewVisibility: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    is_visible: z.boolean(),
  }),

  deleteReview: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Product Variants
  // ============================================================================

  getProductVariants: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createProductVariant: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Name is required").max(100, "Name too long"),
    group_name: z
      .string()
      .max(50, "Group name too long")
      .optional()
      .default("Options"),
    group_ui_type: z
      .enum(["pills", "color", "dropdown"])
      .optional()
      .default("pills"),
    // A variant can belong to more than one axis at once (e.g. Size AND
    // Spice Level) — `group_name` only ever captures the first. This carries
    // the full set; empty/absent means "single-axis, use group_name" as before.
    options: z
      .array(
        z.object({
          name: z.string().max(50),
          value: z.string().max(100),
        }),
      )
      .optional()
      .default([]),
    price_adjustment: z.number().default(0),
    compare_at_price: z.number().nonnegative().nullable().optional(),
    stock: z.number().int().nullable().optional(),
    sku: z.string().max(50, "SKU too long").nullable().optional(),
    color_value: z.string().max(50, "Color value too long").optional(),
    is_active: z.boolean().optional().default(true),
    position: z.number().int().min(0).optional(),
  }),

  updateProductVariant: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(100).optional(),
    group_name: z.string().max(50).optional(),
    group_ui_type: z.enum(["pills", "color", "dropdown"]).optional(),
    options: z
      .array(
        z.object({
          name: z.string().max(50),
          value: z.string().max(100),
        }),
      )
      .optional(),
    price_adjustment: z.number().optional(),
    compare_at_price: z.number().nonnegative().nullable().optional(),
    stock: z.number().int().nullable().optional(),
    sku: z.string().max(50).nullable().optional(),
    color_value: z.string().max(50).optional(),
    is_active: z.boolean().optional(),
    position: z.number().int().min(0).optional(),
  }),

  deleteProductVariant: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  reorderProductVariants: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    order: z
      .array(z.string().uuid("Invalid variant ID"))
      .min(1, "At least one variant required"),
  }),

  // ============================================================================
  // Product Versions
  // ============================================================================

  getProductVersions: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createProductVersion: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    version_name: z
      .string()
      .min(1, "Version name is required")
      .max(50, "Version name too long"),
    release_notes: z.string().nullable().optional(),
    is_active: z.boolean().optional().default(false),
  }),

  updateProductVersion: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    version_name: z.string().min(1).max(50).optional(),
    release_notes: z.string().nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  activateProductVersion: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  deleteProductVersion: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Multi-Store Support
  // ============================================================================

  createStore: z.object({
    name: z
      .string()
      .min(1, "Store name is required")
      .max(100, "Store name too long"),
    slug: z
      .string()
      .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens")
      .optional(),
    // Drives Locations/Registers/Staff/POS access and the storefront branch
    // picker for sellers who also operate in person (a pharmacy, boutique, etc).
    sells_in_person: z.boolean().optional(),
  }),

  // ============================================================================
  // Store Branches (Food Store)
  // ============================================================================

  getBranches: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createBranch: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Branch name is required").max(255),
    address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      })
      .optional(),
    phone: z.string().nullable().optional(),
    business_hours: z.record(z.string(), z.any()).optional(),
    operation_types: z
      .array(z.enum(["dine_in", "pickup", "delivery", "curbside"]))
      .min(1, "At least one fulfilment type is required"),
    prep_time_minutes: z.number().int().min(0).optional(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
    accepting_orders: z.boolean().optional(),
    tax_rate: z.number().min(0).max(100).optional(),
    service_charge_rates: z
      .record(z.string(), z.number().min(0).max(100))
      .nullable()
      .optional(),
    manager: z.string().nullable().optional(),
    format: z.string().nullable().optional(),
  }),

  updateBranch: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(255).optional(),
    address: z
      .object({
        street: z.string().optional(),
        city: z.string().optional(),
        state: z.string().optional(),
        lat: z.number().nullable().optional(),
        lng: z.number().nullable().optional(),
      })
      .optional(),
    phone: z.string().nullable().optional(),
    business_hours: z.record(z.string(), z.any()).optional(),
    operation_types: z
      .array(z.enum(["dine_in", "pickup", "delivery", "curbside"]))
      .min(1, "At least one fulfilment type is required")
      .optional(),
    prep_time_minutes: z.number().int().min(0).optional(),
    is_default: z.boolean().optional(),
    is_active: z.boolean().optional(),
    accepting_orders: z.boolean().optional(),
    tax_rate: z.number().min(0).max(100).optional(),
    service_charge_rates: z
      .record(z.string(), z.number().min(0).max(100))
      .nullable()
      .optional(),
    manager: z.string().nullable().optional(),
    format: z.string().nullable().optional(),
  }),

  deleteBranch: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Store QR Codes (Food Store) — named codes ("Table 12") that resolve to a
  // branch + label so a scanned order carries where to deliver it.
  // ============================================================================

  getQrCodes: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createQrCode: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    label: z.string().min(1, "Label is required").max(100),
    branch_id: z.string().uuid().nullable().optional(),
  }),

  updateQrCode: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    label: z.string().min(1).max(100).optional(),
    branch_id: z.string().uuid().nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  deleteQrCode: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Store Menus (Food Store)
  // ============================================================================

  getMenus: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  createMenu: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Menu name is required").max(255),
    description: z.string().nullable().optional(),
    position: z.number().int().optional(),
    availability: z.record(z.string(), z.any()).nullable().optional(),
    branch_ids: z.array(z.string().uuid()).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  updateMenu: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(255).optional(),
    description: z.string().nullable().optional(),
    position: z.number().int().optional(),
    availability: z.record(z.string(), z.any()).nullable().optional(),
    branch_ids: z.array(z.string().uuid()).nullable().optional(),
    is_active: z.boolean().optional(),
  }),

  deleteMenu: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  getUnits: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Modifier Groups (Food Store)
  // ============================================================================

  getModifierGroups: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    kind: z.enum(["modifier", "addon"]).optional(),
  }),

  getModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  reorderModifierGroups: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    ordered_ids: z.array(z.string().uuid("Invalid modifier group ID")).min(1),
  }),

  reorderModifierOptions: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    ordered_ids: z.array(z.string().uuid("Invalid modifier option ID")).min(1),
  }),

  createModifierOption: modifierOptionInputSchema,

  createModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Group name is required").max(255),
    selection_type: z.enum(["single", "multiple"]).optional(),
    min_selections: z.number().int().min(0).optional(),
    max_selections: z.number().int().min(1).nullable().optional(),
    position: z.number().int().optional(),
    kind: z.enum(["modifier", "addon"]).optional(),
    description: z.string().max(500, "Note is too long").nullable().optional(),
    branch_ids: z.array(z.string().uuid()).nullable().optional(),
    options: z.array(modifierOptionInputSchema).optional(),
  }),

  updateModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(255).optional(),
    selection_type: z.enum(["single", "multiple"]).optional(),
    min_selections: z.number().int().min(0).optional(),
    max_selections: z.number().int().min(1).nullable().optional(),
    position: z.number().int().optional(),
    kind: z.enum(["modifier", "addon"]).optional(),
    description: z.string().max(500, "Note is too long").nullable().optional(),
    branch_ids: z.array(z.string().uuid()).nullable().optional(),
    options: z.array(modifierOptionInputSchema).optional(),
  }),

  deleteModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  updateModifierOption: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1).max(255).optional(),
    price_delta: z.number().optional(),
    is_available: z.boolean().optional(),
    is_default: z.boolean().optional(),
    position: z.number().int().optional(),
    branch_ids: z.array(z.string().uuid()).nullable().optional(),
  }),

  deleteModifierOption: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  attachModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    modifier_group_id: z.string().uuid("Invalid modifier group ID"),
    position: z.number().int().optional(),
  }),

  detachModifierGroup: z.object({
    store_id: z.string().uuid("Invalid store ID"),
  }),

  getStoreById: z.object({
    storeId: z.string().uuid("Invalid store ID"),
  }),

  // ============================================================================
  // Availability Management
  // ============================================================================

  getAvailabilityProfiles: z.object({
    business_id: z.string().uuid("Business ID is required"),
  }),

  createAvailabilityProfile: z.object({
    name: AvailabilityProfileSchema.shape.name,
    description: AvailabilityProfileSchema.shape.description.optional(),
    status: AvailabilityProfileSchema.shape.status.optional(),
    weekly_schedule: AvailabilityProfileSchema.shape.weekly_schedule,
    date_rules: AvailabilityProfileSchema.shape.date_rules.optional(),
    capacity: AvailabilityProfileSchema.shape.capacity.optional(),
    timezone: AvailabilityProfileSchema.shape.timezone.optional(),
    buffer_minutes: AvailabilityProfileSchema.shape.buffer_minutes.optional(),
  }),

  updateAvailabilityProfile: z.object({
    name: AvailabilityProfileSchema.shape.name.optional(),
    description: AvailabilityProfileSchema.shape.description.optional(),
    status: AvailabilityProfileSchema.shape.status.optional(),
    weekly_schedule: AvailabilityProfileSchema.shape.weekly_schedule.optional(),
    date_rules: AvailabilityProfileSchema.shape.date_rules.optional(),
    capacity: AvailabilityProfileSchema.shape.capacity.optional(),
    timezone: AvailabilityProfileSchema.shape.timezone.optional(),
    buffer_minutes: AvailabilityProfileSchema.shape.buffer_minutes.optional(),
  }),

  duplicateAvailabilityProfile: z.object({
    id: z.string().uuid("Invalid profile ID"),
  }),

  deleteAvailabilityProfile: z.object({
    id: z.string().uuid("Invalid profile ID"),
  }),

  checkAvailability: z.object({
    productId: z.string().uuid("Invalid product ID"),
  }),

  assignProductAvailability: z.object({
    productId: z.string().uuid("Invalid product ID"),
    availability_profile_id: z.string().uuid("Invalid profile ID").nullable(),
  }),

  // ============================================================================
  // Teams & Permissions
  // ============================================================================

  inviteMember: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    email: z.string().email("Invalid email address"),
    role_id: z.string().uuid("Invalid role ID"),
  }),

  acceptInvitation: z.object({
    token: z.string().min(1, "Invitation token is required"),
  }),

  removeMember: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    member_id: z.string().uuid("Invalid member ID"),
  }),

  createRole: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    name: z.string().min(1, "Role name is required").max(100),
    permissions: z
      .array(
        z.object({
          resource: z.string(),
          actions: z.array(z.string()),
        }),
      )
      .default([]),
  }),

  updateRole: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    role_id: z.string().uuid("Invalid role ID"),
    permissions: z
      .array(
        z.object({
          resource: z.string(),
          actions: z.array(z.string()),
        }),
      )
      .optional(),
    name: z.string().min(1).max(100).optional(),
  }),

  deleteRole: z.object({
    store_id: z.string().uuid("Invalid store ID"),
    role_id: z.string().uuid("Invalid role ID"),
  }),
};
