import { z } from "zod";
import { FEE_BEARER_VALUES } from "./payment";

export const ProductType = {
  DIGITAL: "digital",
  PHYSICAL: "physical",
  SERVICE: "service",
  DONATION: "donation",
  MEMBERSHIP: "membership",
  BUNDLE: "bundle",
} as const;

export const ProductStatus = {
  PUBLISHED: "published",
  DRAFT: "draft",
} as const;

export const ProductSubtype = {
  MEMBERSHIP: "membership",
  BUNDLE: "bundle",
} as const;

export const OrderStatus = {
  PRE_ORDER: "pre_order",
  PAID: "paid",
  PROCESSING: "processing",
  FULFILLED: "fulfilled",
  CANCELLED: "cancelled",
  REFUNDED: "refunded",
} as const;

export const ShippingCarrier = {
  GIG: "GIG",
  KWIK: "Kwik",
  DHL: "DHL",
  OTHER: "Other",
} as const;

export const ShippingStatus = {
  PENDING: "pending",
  PROCESSING: "processing",
  READY_FOR_PICKUP: "ready_for_pickup",
  SHIPPED: "shipped",
  DELIVERED: "delivered",
} as const;

export const DiscountType = {
  PERCENTAGE: "percentage",
  FIXED: "fixed",
} as const;

export const DiscountKind = {
  CODE: "code",
  AUTOMATIC: "automatic",
} as const;

export const AutomaticDiscountTrigger = {
  SPEND_THRESHOLD: "spend_threshold",
  QUANTITY_BOUGHT: "quantity_bought",
  SPECIFIC_PRODUCTS: "specific_products",
  FIRST_ORDER: "first_order",
} as const;

export const StoreType = {
  GENERAL: "general",
  FOOD: "food",
} as const;

export const OperationType = {
  DINE_IN: "dine_in",
  PICKUP: "pickup",
  DELIVERY: "delivery",
  CURBSIDE: "curbside",
} as const;

const DayHoursSchema = z
  .object({
    open: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
    close: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  })
  .nullable();

const BusinessHoursSchema = z
  .object({
    monday: DayHoursSchema.default(null),
    tuesday: DayHoursSchema.default(null),
    wednesday: DayHoursSchema.default(null),
    thursday: DayHoursSchema.default(null),
    friday: DayHoursSchema.default(null),
    saturday: DayHoursSchema.default(null),
    sunday: DayHoursSchema.default(null),
  })
  .default({
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  });

export const PoliciesCoreSchema = z
  .object({
    privacy_policy: z.string(),
    refund_policy: z.string(),
  })
  .partial();

export const AppearanceCoreSchema = z
  .object({
    description: z.string(),
    cover_image: z.string().nullable(),
    logo: z.string().nullable(),
    accent_color: z.string(),
    availability_profile_id: z.string().uuid().nullable().optional(),
    policies: PoliciesCoreSchema,
    website: z.union([z.string().url(), z.literal("")]).nullable(),
    contact_email: z.string().nullable(),
    contact_phone: z.string().nullable(),
    location: z.string().nullable(),
    social_links: z
      .object({
        facebook: z.string().optional(),
        twitter: z.string().optional(),
        instagram: z.string().optional(),
        whatsapp: z.string().optional(),
      })
      .nullable(),
    business_hours: BusinessHoursSchema.nullable(),
    // "quick_view" opens products in a modal from the listing page instead of
    // navigating to the full product page. Direct links always use full page.
    product_browsing_mode: z.enum(["full_page", "quick_view"]),
  })
  .partial();

export const DeliveryCoreSchema = z
  .object({
    default_carrier: z.enum(["GIG", "Kwik", "DHL", "Other"]),
    enable_tracking: z.boolean(),
    shipping_note: z.string(),
  })
  .partial();

export const AfterPurchaseCoreSchema = z
  .object({
    thank_you_message: z.string(),
    digital_download_instructions: z.string(),
    follow_up_email_note: z.string(),
  })
  .partial();

export const AppearanceSchema = z.object({
  description: z.string().default(""),
  cover_image: z.string().nullable().default(null),
  logo: z.string().nullable().default(null),
  accent_color: z.string().default(""),
  availability_profile_id: z
    .string()
    .uuid()
    .nullable()
    .optional()
    .default(null),
  policies: z
    .object({
      privacy_policy: z.string().default(""),
      refund_policy: z.string().default(""),
    })
    .default({ privacy_policy: "", refund_policy: "" }),
  website: z
    .union([z.string().url(), z.literal("")])
    .nullable()
    .default(null),
  contact_email: z.string().default(""),
  contact_phone: z.string().default(""),
  location: z.string().default(""),
  social_links: z
    .object({
      facebook: z.string().optional(),
      twitter: z.string().optional(),
      instagram: z.string().optional(),
      whatsapp: z.string().optional(),
    })
    .default({}),
  business_hours: BusinessHoursSchema.default({
    monday: null,
    tuesday: null,
    wednesday: null,
    thursday: null,
    friday: null,
    saturday: null,
    sunday: null,
  }),
  product_browsing_mode: z
    .enum(["full_page", "quick_view"])
    .default("quick_view"),
});

export const DeliverySchema = z.object({
  default_carrier: z.enum(["GIG", "Kwik", "DHL", "Other"]).default("GIG"),
  enable_tracking: z.boolean().default(true),
  shipping_note: z.string().default(""),
});

export const AfterPurchaseSchema = z.object({
  thank_you_message: z
    .string()
    .default("Thank you for your purchase! We appreciate your business."),
  digital_download_instructions: z
    .string()
    .default("Your download link has been sent to your email."),
  follow_up_email_note: z
    .string()
    .default(
      "A confirmation email will be sent to you shortly with order details.",
    ),
});

export const DigitalAssetSchema = z.object({
  url: z.string().url(),
  file_name: z.string(),
  file_size: z.number(),
  mime_type: z.string(),
});

export const DigitalCoreSchema = z
  .object({
    download_url: z
      .string()
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .refine((val) => val === null || /^https?:\/\/.+/.test(val), {
        message: "Invalid URL format",
      }),
    download_limit: z.number().int().nullable(),
    file_type: z.string().nullable(),
    delivery_type: z.enum(["upload", "link"]).nullable(),
    asset: DigitalAssetSchema.nullable(),
    primary_format: z.enum(["pdf", "epub", "mobi", "other"]).nullable(),
    has_sample: z.boolean(),
    sample_url: z.string().nullable(),
    page_count: z.number().int().nullable(),
    files: z
      .object({
        pdf_url: z.string().nullable(),
        epub_url: z.string().nullable(),
        mobi_url: z.string().nullable(),
        pdf_asset: DigitalAssetSchema.nullable(),
        epub_asset: DigitalAssetSchema.nullable(),
        mobi_asset: DigitalAssetSchema.nullable(),
      })
      .partial()
      .nullable(),
  })
  .partial();

export const PhysicalCoreSchema = z
  .object({
    weight: z.number().nonnegative().nullable(),
    requires_shipping: z.boolean(),
    dimensions: z
      .object({
        length: z.number().nonnegative(),
        width: z.number().nonnegative(),
        height: z.number().nonnegative(),
      })
      .partial()
      .nullable(),
  })
  .partial();

export const ServiceCoreSchema = z
  .object({
    duration_minutes: z.number().int().nonnegative(),
    location: z.string().nullable(),
    availability: z.string().nullable(),
    approval_required: z.boolean(),
  })
  .partial();

export const MembershipCoreSchema = z
  .object({
    billing_cycle: z.enum(["monthly", "quarterly", "yearly", "one-time"]),
    tier_name: z.string(),
    benefits: z.array(z.string()),
    renewal_reminder_days: z.number().int(),
  })
  .partial();

export const BundleCoreSchema = z
  .object({
    pricing_mode: z.enum(["fixed", "discount", "sum"]),
    discount_percentage: z.number().nullable(),
    product_ids: z.array(z.string().uuid()),
  })
  .partial();

export const DonationCoreSchema = z
  .object({
    suggested_amount: z.number().nonnegative(),
    allow_custom_amount: z.boolean(),
  })
  .partial();

export const ProductCircleLinkSchema = z.object({
  product_id: z.string().uuid().optional(), // filled by the server from the route param
  circle_id: z.string().uuid(),
  default_plan_id: z.string().uuid().nullable().default(null),
  allow_tier_selection: z.boolean().default(false),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

// Unified Module Link — links a store product to any platform module entity.
export const ModuleLinkType = {
  CIRCLE: "circle",
  PUBLICATION: "publication",
  COURSE: "course",
  EVENT_TYPE: "event_type",
} as const;

export type ModuleLinkTypeValue =
  (typeof ModuleLinkType)[keyof typeof ModuleLinkType];

export const ProductModuleLinkSchema = z.object({
  product_id: z.string().uuid().optional(),
  module_type: z.enum(["circle", "publication", "course", "event_type"]),
  entity_id: z.string().uuid(),
  config: z
    .record(z.string(), z.unknown())
    .default({}),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  // Resolved metadata (populated at read time, not stored)
  _entity_meta: z
    .object({
      name: z.string(),
      description: z.string().optional(),
      slug: z.string().optional(),
      price: z.number().optional(),
      currency: z.string().optional(),
      image_url: z.string().nullable().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

export const CurrencyPriceSchema = z.object({
  price: z.number().positive(),
  compare_at_price: z.number().positive().nullable().default(null),
});

// Per-currency price overrides, keyed by ISO currency code. Currencies absent
// from the map fall back to live FX conversion of the NGN base price.
export const CurrencyPriceMapSchema = z.record(
  z.string().length(3),
  CurrencyPriceSchema,
);

// API projection for the catalog and inventory overrides at one branch.
// Inventory is normalized in branch_inventory_overrides; variant_stock is a
// response/input convenience map rather than a JSONB database column.
export const ProductBranchOverrideSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  branch_id: z.string().uuid(),
  is_available: z.boolean().default(true),
  price: z.number().nonnegative().nullable().default(null),
  currency_prices: CurrencyPriceMapSchema.nullable().default(null),
  // Overrides the product's own lead_time_hours at this branch specifically
  // (e.g. a smaller kitchen needing more advance notice). Null = use the
  // product's value.
  lead_time_hours: z.number().int().min(0).nullable().default(null),
  // Omitted means inherit global inventory. Explicit null means unlimited.
  stock_quantity: z.number().int().min(0).nullable().optional(),
  reserved_quantity: z.number().int().min(0).optional(),
  variant_stock: z
    .record(z.string().uuid(), z.number().int().min(0).nullable())
    .default({}),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ProductBranchOverride = z.infer<typeof ProductBranchOverrideSchema>;

export const ProductCoreSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  description: z.string(),
  price: z.number().nonnegative(),
  cost: z.number().nonnegative().nullable().optional(),
  barcode: z.string().trim().max(128).nullable().optional(),
  compare_at_price: z.number().nonnegative().nullable(),
  currency: z.string().length(3),
  // Explicit per-currency price overrides (non-NGN). Absent currencies fall back
  // to FX conversion of the NGN base price above.
  currency_prices: CurrencyPriceMapSchema.optional(),
  type: z.enum([
    "digital",
    "physical",
    "service",
    "membership",
    "bundle",
    "donation",
  ]),
  subtype: z.enum(["membership", "bundle"]).nullable(),
  status: z.enum(["published", "draft"]),
  variant_group_name: z.string(),
  variant_ui_type: z.enum(["pills", "color"]),
  digital: DigitalCoreSchema.nullable(),
  physical: PhysicalCoreSchema.nullable(),
  service: ServiceCoreSchema.nullable(),
  membership: MembershipCoreSchema.nullable(),
  bundle: BundleCoreSchema.nullable(),
  donation: DonationCoreSchema.nullable(),
  circle_link: ProductCircleLinkSchema.nullable().optional(),
  module_link: ProductModuleLinkSchema.nullable().optional(),
  cover_image: z.string().nullable(),
  images: z.array(z.string()).nullable(),
  stock: z.number().int().nullable(),
  orders_count: z.number().int(),
  // When true the buyer sets their own amount at checkout (shares the donation
  // price-resolution path; differs only in UI wording).
  allow_custom_price: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string(),
  category_ids: z.array(z.string().uuid()),
  marketplace_category_id: z.string().uuid().nullable(),
  supplier_ids: z.array(z.string().uuid()).optional(),
  is_sellable: z.boolean().default(true),
  created_by: z.string().uuid().nullable().optional(),
  storefront_enabled: z.boolean().default(true),
  pos_enabled: z.boolean().default(true),
  marketplace_enabled: z.boolean().default(true),
  digital_link_expiry_hours: z.number().int().min(1).max(8760).nullable().optional(),
  availability_profile_id: z.string().uuid().nullable().optional(),
  variants: z.array(z.any()).optional(),
  options_config: z.array(z.object({
    id: z.string().min(1).max(120),
    name: z.string().trim().min(1).max(120),
    values: z.array(z.string().trim().min(1).max(255)).max(100),
  })).max(10).default([]),
  // Pre-order fields (applicable to digital products)
  is_pre_order: z.boolean().optional(),
  pre_order_release_date: z.string().nullable().optional(),
  pre_order_message: z.string().nullable().optional(),
  pre_order_deposit_pct: z.number().int().min(1).max(100).nullable().optional(),
  // Where to send the buyer after a successful purchase (e.g. a WhatsApp group).
  after_purchase_redirect_url: z.string().url().nullable().optional(),
  // What the merchant asks the buyer for at checkout, plus any custom questions.
  checkout: z
    .object({
      collectName: z.boolean().default(true),
      collectEmail: z.boolean().default(true),
      collectPhone: z.boolean().default(true),
      collectBusinessName: z.boolean().default(false),
      collectOtherDetails: z.boolean().default(false),
      customQuestions: z.array(z.string()).default([]),
    })
    .nullable()
    .optional(),
  // Nullable override of the branch's default prep time for this specific item.
  prep_time_minutes: z.number().int().min(0).nullable().optional(),
  is_available_today: z.boolean().optional(),
  available_branch_ids: z.array(z.string().uuid()).nullable().optional(),
  // Minimum advance notice required before this item can be picked up/
  // delivered (e.g. 48 for a bulk catering order) — enforced at checkout
  // against the customer-provided slot date/time. Null = no lead time.
  lead_time_hours: z.number().int().min(0).nullable().optional(),
  unit_id: z.string().uuid().nullable().optional(),
  unit_of_sale: z.string().trim().min(1).max(20).optional(),
  quantity_step: z.number().positive().optional(),
  min_order_quantity: z.number().positive().optional(),
  // Upper bound on a single order's quantity for this item — e.g. capping a
  // bulk catering package at its intended guest range. Null = no cap.
  max_order_quantity: z.number().positive().nullable().optional(),
  // Structured allergen list (e.g. ["gluten", "shellfish"]) — safety-
  // relevant info shown as a distinct block on the storefront rather than
  // buried in the description.
  allergens: z.array(z.string()).nullable().optional(),
  // Enables prep-time, allergen, and modifier UI on the storefront.
  has_prep_time: z.boolean().default(false),
});

export const ProductBaseSchema = z.object({
  id: ProductCoreSchema.shape.id,
  store_id: ProductCoreSchema.shape.store_id,
  name: ProductCoreSchema.shape.name,
  description: ProductCoreSchema.shape.description.default(""),
  price: ProductCoreSchema.shape.price,
  cost: ProductCoreSchema.shape.cost,
  barcode: ProductCoreSchema.shape.barcode,
  compare_at_price: ProductCoreSchema.shape.compare_at_price.default(null),
  currency: ProductCoreSchema.shape.currency.default("NGN"),
  currency_prices: CurrencyPriceMapSchema.default({}),
  type: ProductCoreSchema.shape.type,
  subtype: ProductCoreSchema.shape.subtype.default(null),
  status: ProductCoreSchema.shape.status.default("draft"),
  variant_group_name:
    ProductCoreSchema.shape.variant_group_name.default("Options"),
  variant_ui_type: ProductCoreSchema.shape.variant_ui_type.default("pills"),
  digital: z
    .object({
      download_url: DigitalCoreSchema.shape.download_url.default(null),
      download_limit: DigitalCoreSchema.shape.download_limit.default(null),
      file_type: DigitalCoreSchema.shape.file_type.default(null),
      delivery_type: DigitalCoreSchema.shape.delivery_type.default(null),
      asset: DigitalCoreSchema.shape.asset.default(null),
      primary_format: DigitalCoreSchema.shape.primary_format.default(null),
      has_sample: DigitalCoreSchema.shape.has_sample.default(false),
      sample_url: DigitalCoreSchema.shape.sample_url.default(null),
      page_count: DigitalCoreSchema.shape.page_count.default(null),
      files: DigitalCoreSchema.shape.files.default(null),
    })
    .nullable()
    .default(null),
  physical: z
    .object({
      weight: PhysicalCoreSchema.shape.weight.default(0),
      requires_shipping:
        PhysicalCoreSchema.shape.requires_shipping.default(true),
      dimensions: z
        .object({
          length: z.number().nonnegative().default(0),
          width: z.number().nonnegative().default(0),
          height: z.number().nonnegative().default(0),
        })
        .nullable()
        .default({ length: 0, width: 0, height: 0 }),
    })
    .nullable()
    .default(null),
  service: z
    .object({
      duration_minutes: ServiceCoreSchema.shape.duration_minutes.default(0),
      location: ServiceCoreSchema.shape.location.default(null),
      availability: ServiceCoreSchema.shape.availability.default(null),
      approval_required:
        ServiceCoreSchema.shape.approval_required.default(false),
    })
    .nullable()
    .default(null),
  membership: z
    .object({
      billing_cycle:
        MembershipCoreSchema.shape.billing_cycle.default("monthly"),
      tier_name: MembershipCoreSchema.shape.tier_name.default(""),
      benefits: MembershipCoreSchema.shape.benefits.default([]),
      renewal_reminder_days:
        MembershipCoreSchema.shape.renewal_reminder_days.default(7),
    })
    .nullable()
    .default(null),
  bundle: z
    .object({
      pricing_mode: BundleCoreSchema.shape.pricing_mode.default("fixed"),
      discount_percentage:
        BundleCoreSchema.shape.discount_percentage.default(null),
      product_ids: BundleCoreSchema.shape.product_ids.default([]),
    })
    .nullable()
    .default(null),
  donation: z
    .object({
      suggested_amount: DonationCoreSchema.shape.suggested_amount.default(0),
      allow_custom_amount:
        DonationCoreSchema.shape.allow_custom_amount.default(true),
    })
    .nullable()
    .default(null),
  cover_image: ProductCoreSchema.shape.cover_image.default(null),
  images: ProductCoreSchema.shape.images.default([]),
  stock: ProductCoreSchema.shape.stock.default(null),
  orders_count: ProductCoreSchema.shape.orders_count.default(0),
  allow_custom_price: z.boolean().default(false),
  created_at: ProductCoreSchema.shape.created_at,
  updated_at: ProductCoreSchema.shape.updated_at,
  category_ids: ProductCoreSchema.shape.category_ids.default([]),
  marketplace_category_id:
    ProductCoreSchema.shape.marketplace_category_id.default(null),
  supplier_ids: ProductCoreSchema.shape.supplier_ids.default([]),
  is_sellable: ProductCoreSchema.shape.is_sellable,
  created_by: ProductCoreSchema.shape.created_by.default(null),
  storefront_enabled: ProductCoreSchema.shape.storefront_enabled,
  pos_enabled: ProductCoreSchema.shape.pos_enabled,
  marketplace_enabled: ProductCoreSchema.shape.marketplace_enabled,
  digital_link_expiry_hours:
    ProductCoreSchema.shape.digital_link_expiry_hours.default(null),
  availability_profile_id:
    ProductCoreSchema.shape.availability_profile_id.default(null),
  variants: ProductCoreSchema.shape.variants.default([]),
  options_config: ProductCoreSchema.shape.options_config,
  circle_link: ProductCircleLinkSchema.nullable().optional().default(null),
  module_link: ProductModuleLinkSchema.nullable().optional().default(null),
  is_pre_order: z.boolean().default(false),
  pre_order_release_date: z.string().nullable().default(null),
  pre_order_message: z.string().nullable().default(null),
  pre_order_deposit_pct: z
    .number()
    .int()
    .min(1)
    .max(100)
    .nullable()
    .default(null),
  after_purchase_redirect_url: z.string().url().nullable().default(null),
  checkout: z
    .object({
      collectName: z.boolean().default(true),
      collectEmail: z.boolean().default(true),
      collectPhone: z.boolean().default(true),
      collectBusinessName: z.boolean().default(false),
      collectOtherDetails: z.boolean().default(false),
      customQuestions: z.array(z.string()).default([]),
    })
    .nullable()
    .default(null),
  prep_time_minutes: ProductCoreSchema.shape.prep_time_minutes.default(null),
  is_available_today: z.boolean().default(true),
  available_branch_ids:
    ProductCoreSchema.shape.available_branch_ids.default(null),
  lead_time_hours: ProductCoreSchema.shape.lead_time_hours.default(null),
  unit_id: ProductCoreSchema.shape.unit_id.default(null),
  unit_of_sale: z.string().default("piece"),
  quantity_step: z.number().positive().default(1),
  min_order_quantity: z.number().positive().default(1),
  max_order_quantity: ProductCoreSchema.shape.max_order_quantity.default(null),
  allergens: ProductCoreSchema.shape.allergens.default(null),
  has_prep_time: ProductCoreSchema.shape.has_prep_time,
});

export const ProductUpdateSchema = ProductCoreSchema.partial();

export const ProductSchema = ProductBaseSchema.superRefine((data, ctx) => {
  if (data.availability_profile_id && data.type !== "service") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Availability profile can only be set for service products",
      path: ["availability_profile_id"],
    });
  }

  if (data.type !== "donation" && data.donation) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Donation metadata is only allowed on donation products",
      path: ["donation"],
    });
  }
});

export const AvailabilityProfileSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  status: z.enum(["active", "inactive"]).default("active"),
  description: z.string().nullable().default(null),
  buffer_minutes: z.number().int().min(0).default(0),
  weekly_schedule: z
    .array(
      z.object({
        day: z.enum([
          "Monday",
          "Tuesday",
          "Wednesday",
          "Thursday",
          "Friday",
          "Saturday",
          "Sunday",
        ]),
        isEnabled: z.boolean().default(true),
        ranges: z
          .array(
            z.object({
              startTime: z
                .string()
                .regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format"),
              endTime: z
                .string()
                .regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format"),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  date_rules: z
    .object({
      startDate: z.string().nullable().default(null),
      endDate: z.string().nullable().default(null),
      blackoutDates: z
        .array(
          z.object({
            date: z.string(), // YYYY-MM-DD
            reason: z.string().nullable().default(null),
          }),
        )
        .default([]),
    })
    .default({ startDate: null, endDate: null, blackoutDates: [] }),
  capacity: z
    .object({
      maxPerSlot: z.number().int().nullable().default(null),
      maxPerDay: z.number().int().nullable().default(null),
      isEnabled: z.boolean().default(false),
    })
    .default({ maxPerSlot: null, maxPerDay: null, isEnabled: false }),
  timezone: z.string().default("Africa/Lagos"),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ProductVariantSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  color_value: z.string().max(50).optional().nullable(),
  group_name: z.string().max(50).default("Options"),
  group_ui_type: z.enum(["pills", "color", "dropdown"]).default("pills"),
  // Full multi-axis breakdown for this combination (e.g. Size + Spice
  // Level at once) — group_name only ever holds the first axis. Empty
  // means legacy single-axis data; readers fall back to group_name/name.
  options: z
    .array(z.object({ name: z.string().max(50), value: z.string().max(100) }))
    .default([]),
  price_adjustment: z.number().default(0),
  compare_at_price: z.number().nonnegative().nullable().default(null),
  stock: z.number().int().nullable().default(null),
  sku: z.string().max(50).nullable().default(null),
  is_active: z.boolean().default(true),
  position: z.number().int().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ProductVersionSchema = z.object({
  id: z.string().uuid(),
  product_id: z.string().uuid(),
  store_id: z.string().uuid(),
  version_name: z.string().min(1).max(50),
  release_notes: z.string().nullable().default(null),
  is_active: z.boolean().default(false),
  created_at: z.string(),
  updated_at: z.string(),
});

export const StoreReviewSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  product_id: z.string().uuid().nullable().default(null),
  customer_name: z.string().min(1).max(100),
  customer_email: z.string().email(),
  rating: z.number().int().min(1).max(5),
  title: z.string().max(150).nullable().default(null),
  content: z.string().nullable().default(null),
  is_verified: z.boolean().default(false),
  is_visible: z.boolean().default(true),
  created_at: z.string(),
  updated_at: z.string(),
});

export const CustomerSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  phone: z.string().optional(),
  address: z.string().optional(),
});

export const BookingSlotSchema = z.object({
  startTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format"),
  endTime: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:mm format"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format"),
});

export const OrderItemSchema = z.object({
  product_id: z.string().uuid(),
  product_name: z.string(),
  product_type: z.enum(["digital", "physical", "service"]),
  quantity: z.number().int().positive(),
  price: z.number().min(0),
  cover_image: z.string().nullable(),
  slot: BookingSlotSchema.nullable().optional().default(null),
});

export const OrderSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  user_id: z.string().uuid().nullable().optional(),
  order_number: z.string().optional(),
  customer_name: z.string(),
  customer_email: z.string().email(),
  customer_phone: z.string().optional(),
  customer_address: z.string().optional(),
  items: z.array(z.any()),
  subtotal: z.number().optional(),
  discount: z.number().default(0),
  discount_code: z.string().nullable().optional(),
  discount_details: z.array(z.any()).default([]),
  delivery_fee: z.number().nonnegative().optional(),
  tax_amount: z.number().nonnegative().default(0),
  service_charge_amount: z.number().nonnegative().default(0),
  total: z.number().nonnegative(),
  currency: z.string().length(3).default("NGN"),
  status: z
    .enum(["paid", "processing", "fulfilled", "cancelled", "refunded"])
    .default("paid"),
  payment_reference: z.string(),
  shipping_carrier: z.string().optional(),
  shipping_tracking_number: z.string().optional(),
  shipping_status: z
    .enum(["pending", "processing", "ready_for_pickup", "shipped", "delivered"])
    .optional(),
  shipped_at: z.string().datetime().optional(),
  delivered_at: z.string().datetime().optional(),
  notes: z.string().optional(),
  fulfillment_type: z
    .enum(["dine_in", "pickup", "delivery", "curbside"])
    .nullable()
    .optional(),
  branch_id: z.string().uuid().nullable().optional(),
  utensils_requested: z.boolean().default(false),
  // Snapshotted from the QR code entry (stored in store_branches.qr_codes JSONB)
  // at order-creation time (not live-joined) so a later rename/deactivation
  // never rewrites history — same pattern as product_name being copied onto order items.
  qr_code_id: z.string().uuid().nullable().optional(),
  location_label: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  fulfilled_at: z.string().datetime().optional(),
});

export const DiscountCodeBaseSchema = z.object({
  id: z.string().uuid().optional(),
  store_id: z.string().uuid(),
  kind: z.enum(["code", "automatic"]).default("code"),
  name: z.string().min(1).max(100).nullable().optional(),
  code: z.string().min(1).max(50).nullable().optional(),
  type: z.enum(["percentage", "fixed"]),
  value: z.number().positive(),
  is_active: z.boolean().default(true),
  usage_count: z.number().int().default(0),
  max_usage: z.number().int().positive().nullable().optional(),
  one_use_per_customer: z.boolean().default(false),
  starts_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  applies_to: z.enum(["all", "specific"]).default("all"),
  product_ids: z.array(z.string().uuid()).default([]),
  trigger: z
    .enum([
      "spend_threshold",
      "quantity_bought",
      "specific_products",
      "first_order",
    ])
    .nullable()
    .optional(),
  trigger_value: z.number().positive().nullable().optional(),
  qualification_product_ids: z.array(z.string().uuid()).default([]),
  allow_code_on_top: z.boolean().default(false),
  show_on_storefront: z.boolean().default(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export const DiscountCodeSchema = DiscountCodeBaseSchema.superRefine((discount, context) => {
  if (discount.kind === "code" && !discount.code) {
    context.addIssue({
      code: "custom",
      path: ["code"],
      message: "Discount code is required",
    });
  }

  if (discount.kind === "automatic") {
    if (!discount.name) {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Automatic discount name is required",
      });
    }
    if (!discount.trigger) {
      context.addIssue({
        code: "custom",
        path: ["trigger"],
        message: "Automatic discount trigger is required",
      });
    }
    if (discount.code) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "Automatic discounts cannot have a customer code",
      });
    }
    if (
      (discount.trigger === "spend_threshold" ||
        discount.trigger === "quantity_bought") &&
      !discount.trigger_value
    ) {
      context.addIssue({
        code: "custom",
        path: ["trigger_value"],
        message: "This trigger requires a positive condition value",
      });
    }
    if (
      discount.trigger === "quantity_bought" &&
      discount.trigger_value != null &&
      !Number.isInteger(discount.trigger_value)
    ) {
      context.addIssue({
        code: "custom",
        path: ["trigger_value"],
        message: "Quantity trigger must use a whole number",
      });
    }
    if (
      discount.trigger === "specific_products" &&
      discount.qualification_product_ids.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["qualification_product_ids"],
        message: "Select at least one qualification product",
      });
    }
  }

  if (discount.type === "percentage" && discount.value > 100) {
    context.addIssue({
      code: "custom",
      path: ["value"],
      message: "Percentage discounts cannot exceed 100%",
    });
  }

  if (
    discount.starts_at &&
    discount.expires_at &&
    new Date(discount.expires_at) <= new Date(discount.starts_at)
  ) {
    context.addIssue({
      code: "custom",
      path: ["expires_at"],
      message: "End date must be after start date",
    });
  }

  if (discount.applies_to === "specific" && discount.product_ids.length === 0) {
    context.addIssue({
      code: "custom",
      path: ["product_ids"],
      message: "Select at least one discounted product",
    });
  }
});

export const StoreCustomerSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  email: z.string().email(),
  name: z.string().max(100),
  phone: z.string().max(20).nullable().default(null),
  address: z.string().nullable().default(null),
  total_orders: z.number().int().default(0),
  total_spent: z.number().default(0),
  last_order_at: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

export const ServiceBookingSchema = z.object({
  id: z.string().uuid(),
  order_id: z.string().uuid(),
  product_id: z.string().uuid(),
  store_id: z.string().uuid(),
  customer_id: z.string().uuid().nullable().default(null),
  customer_email: z.string().email().nullable().default(null),
  customer_name: z.string().nullable().default(null),
  booking_date: z.string(), // YYYY-MM-DD
  start_time: z.string(), // HH:mm
  end_time: z.string(), // HH:mm
  status: z.enum([
    "pending",
    "confirmed",
    "declined",
    "rescheduled",
    "completed",
    "cancelled",
    "no_show",
  ]),
  notes: z.string().nullable().default(null),
  decline_reason: z.string().nullable().default(null),
  rescheduled_from: z.string().nullable().default(null),
  initiated_by: z.enum(["creator", "customer"]).nullable().default(null),
  location_type: z.string().nullable().default(null),
  location_details: z.string().nullable().default(null),
  approval_required: z.boolean().default(false),
  duration_minutes: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const StoreCategorySchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  slug: z.string().max(100),
  description: z.string().nullable().default(null),
  is_active: z.boolean().default(true),
  position: z.number().int().default(0),
  product_count: z.number().int().default(0).optional(), // Virtual field for UI
  parent_id: z.string().uuid().nullable().default(null),
  is_menu: z.boolean().default(false),
  availability: z.record(z.string(), z.any()).nullable().default(null),
  branch_ids: z.array(z.string().uuid()).nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

// Store menus are now store_categories rows with is_menu = true
export type StoreMenu = z.infer<typeof StoreCategorySchema> & {
  availability?: Record<string, any> | null;
  branch_ids?: string[] | null;
};

export const StoreUnitSchema = z.object({
  id: z.string().uuid(),
  code: z.string().min(1).max(20),
  name: z.string().min(1).max(100),
  symbol: z.string().min(1).max(20),
  type: z.enum(["count", "weight", "volume", "length", "area", "time"]),
  conversion_factor: z.number().nullable().optional(),
  is_active: z.boolean(),
  sort_order: z.number().int(),
  product_count: z.number().int().nonnegative().default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type StoreUnit = z.infer<typeof StoreUnitSchema>;

export const ModifierOptionSchema = z.object({
  id: z.string().uuid(),
  modifier_group_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  price_delta: z.number().default(0),
  is_available: z.boolean().default(true),
  is_default: z.boolean().default(false),
  position: z.number().int().default(0),
  // Branches this option is offered at. Null = all branches the parent
  // group is offered at (same null-means-all convention as
  // menu branch_ids / products.available_branch_ids).
  branch_ids: z.array(z.string().uuid()).nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ModifierOption = z.infer<typeof ModifierOptionSchema>;

export const ModifierGroupSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  selection_type: z.enum(["single", "multiple"]).default("single"),
  min_selections: z.number().int().min(0).default(0),
  max_selections: z.number().int().nullable().default(null),
  position: z.number().int().default(0),
  // 'modifier' = required/optional choice group (e.g. "Choose your protein");
  // 'addon' = optional extra item with its own price (e.g. "Add fries").
  // Shared store-wide across menus — same reusable-groups system either way.
  kind: z.enum(["modifier", "addon"]).default("modifier"),
  // Free-text note shown alongside the group, e.g. "Max 2 sauces, split
  // evenly" — informational only, doesn't affect min/max enforcement.
  description: z.string().nullable().default(null),
  // Branches this group is offered at. Null = all branches.
  branch_ids: z.array(z.string().uuid()).nullable().default(null),
  // Populated on read: full option payloads for single-group reads, [] for list reads.
  options: z.array(ModifierOptionSchema).optional(),
  // Number of options in this group — computed on list reads so the count is
  // available without pulling every option payload.
  options_count: z.number().int().min(0).default(0),
  // Number of products this group is attached to (populated on read).
  product_count: z.number().int().min(0).default(0),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ModifierGroup = z.infer<typeof ModifierGroupSchema>;

/**
 * Editable fields for creating/updating a modifier group. Keeps insert/update
 * payloads typed instead of passing a free-form partial of the read shape.
 */
export type ModifierGroupUpsert = {
  name: string;
  description?: string | null;
  selection_type?: "single" | "multiple";
  min_selections?: number;
  max_selections?: number | null;
  position?: number;
  kind?: "modifier" | "addon";
  branch_ids?: string[] | null;
  /** Options to persist in the group's JSONB array on create/update. */
  options?: Partial<ModifierOption>[];
};

export const BranchAddressSchema = z
  .object({
    street: z.string(),
    city: z.string(),
    state: z.string(),
    lat: z.number().nullable(),
    lng: z.number().nullable(),
  })
  .partial();

// Supports multiple ranges per day (e.g. brunch + dinner) unlike the
// single-range stores.appearance.business_hours. Accepts legacy single-range
// {open,close} objects and normalizes them to a one-item array on read.
const BranchDayHoursRangeSchema = z.object({
  open: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
  close: z.string().regex(/^\d{2}:\d{2}$/, "Time must be in HH:MM format"),
});
const BranchDayHoursSchema = z
  .union([BranchDayHoursRangeSchema, z.array(BranchDayHoursRangeSchema)])
  .nullable()
  .default(null)
  .transform((val) => {
    if (val == null) return null;
    return Array.isArray(val) ? val : [val];
  });
export const BranchBusinessHoursSchema = z.object({
  monday: BranchDayHoursSchema,
  tuesday: BranchDayHoursSchema,
  wednesday: BranchDayHoursSchema,
  thursday: BranchDayHoursSchema,
  friday: BranchDayHoursSchema,
  saturday: BranchDayHoursSchema,
  sunday: BranchDayHoursSchema,
});

export const StoreBranchSchema = z.object({
  id: z.string().uuid(),
  store_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  address: BranchAddressSchema.default({}),
  phone: z.string().nullable().default(null),
  business_hours: BranchBusinessHoursSchema,
  operation_types: z
    .array(z.enum(["dine_in", "pickup", "delivery", "curbside"]))
    .min(1, "At least one fulfilment type is required"),
  prep_time_minutes: z.number().int().min(0).default(20),
  is_default: z.boolean().default(false),
  is_active: z.boolean().default(true),
  // Meant to be flipped often (kitchen overwhelmed, out of an ingredient,
  // closing early) — distinct from is_active, which is structural
  // (removes the branch from the dashboard entirely).
  accepting_orders: z.boolean().default(true),
  // Sales tax percentage applied to the subtotal at checkout when this
  // branch is selected (e.g. 8 = 8%).
  tax_rate: z.number().min(0).max(100).default(0),
  // Additional percentage applied on top of tax, keyed by fulfilment type
  // (e.g. { dine_in: 10 } for a dine-in-only service charge). A missing key
  // means no service charge for that fulfilment type.
  service_charge_rates: z
    .record(z.string(), z.number().min(0).max(100))
    .nullable()
    .default(null),
  // Informational only — not used in any logic.
  manager: z.string().nullable().default(null),
  format: z.string().nullable().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});
export type StoreBranch = z.infer<typeof StoreBranchSchema>;

// Named QR codes ("Table 12") a customer scans to reach the storefront with
// a branch + location pre-resolved — not seat/table capacity management,
// just naming and resolving a code to where an order should be delivered.
// Stored as JSONB array on store_branches.qr_codes (no separate DB table).
export type StoreQrCode = {
  id: string;
  store_id: string;
  branch_id: string | null;
  label: string;
  code: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export const StoreSettingsCoreSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  business_id: z.string().uuid().nullable().optional(),
  name: z.string().min(1).max(255),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  registered_business_name: z.string().max(255).optional(),
  is_live: z.boolean(),
  // Enables Locations/Registers/Staff/POS tabs and the storefront branch picker.
  sells_in_person: z.boolean().default(false),
  // How often /pos re-prompts a staff PIN — per_sale (before every charge),
  // per_session (unlocks the till until "Switch user"), or both (unlocks
  // the till for the shift AND still confirms before every charge).
  pos_pin_mode: z.enum(["per_sale", "per_session", "both"]).default("per_session"),
  appearance: AppearanceCoreSchema.nullable(),
  delivery: DeliveryCoreSchema.nullable(),
  after_purchase: AfterPurchaseCoreSchema.nullable(),
  paystack_subaccount_code: z.string().nullable().optional(),
  // Currencies this store sells in. NGN is the implicit base and is always allowed.
  supported_currencies: z.array(z.string().length(3)).default(["NGN"]),
  business: z
    .object({
      id: z.string().uuid(),
      name: z.string(),
      paystack_subaccount_code: z.string().nullable().optional(),
      paystack_fee_bearer: z
        .enum(FEE_BEARER_VALUES)
        .nullable()
        .optional(),
    })
    .nullable()
    .optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

// Zod's `.partial()` makes every field optional but does NOT strip
// `.default()` — a field the caller omits entirely still gets parsed in as
// its default value (confirmed: `z.object({b: z.boolean().default(false)}).partial().parse({})`
// returns `{b: false}`, not `{}`). Since saveUserStore does a shallow
// `{...existing, ...payload}` merge, that silently-filled default then
// overwrites the real stored value — e.g. a `/store/save` call that only
// touches `registered_business_name` was observed resetting
// `sells_in_person` back to false. Strip `.default()` off every field
// before going `.partial()` so an omitted field is truly omitted, not
// defaulted, and the merge leaves it alone.
const stripDefaults = <T extends z.ZodRawShape>(shape: T): T =>
  Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [
      key,
      typeof (schema as any).removeDefault === "function"
        ? (schema as any).removeDefault()
        : schema,
    ]),
  ) as T;

export const StoreSettingsUpdateSchema = z
  .object(stripDefaults(StoreSettingsCoreSchema.shape))
  .partial();

export const StoreSettingsSchema = z.object({
  id: StoreSettingsCoreSchema.shape.id,
  user_id: StoreSettingsCoreSchema.shape.user_id,
  business_id: StoreSettingsCoreSchema.shape.business_id.default(null),
  name: StoreSettingsCoreSchema.shape.name,
  slug: StoreSettingsCoreSchema.shape.slug,
  registered_business_name:
    StoreSettingsCoreSchema.shape.registered_business_name,
  is_live: StoreSettingsCoreSchema.shape.is_live.default(false),
  sells_in_person: StoreSettingsCoreSchema.shape.sells_in_person,
  appearance: AppearanceSchema.default({
    description: "",
    cover_image: null,
    logo: null,
    accent_color: "",
    availability_profile_id: null,
    policies: { privacy_policy: "", refund_policy: "" },
    website: null,
    contact_email: "",
    contact_phone: "",
    location: "",
    social_links: {},
    business_hours: {
      monday: null,
      tuesday: null,
      wednesday: null,
      thursday: null,
      friday: null,
      saturday: null,
      sunday: null,
    },
    product_browsing_mode: "quick_view",
  }),
  delivery: DeliverySchema.default({
    default_carrier: "GIG",
    enable_tracking: true,
    shipping_note: "",
  }),
  after_purchase: AfterPurchaseSchema.default({
    thank_you_message:
      "Thank you for your purchase! We appreciate your business.",
    digital_download_instructions:
      "Your download link has been sent to your email.",
    follow_up_email_note:
      "A confirmation email will be sent to you shortly with order details.",
  }),
  paystack_subaccount_code:
    StoreSettingsCoreSchema.shape.paystack_subaccount_code.default(null),
  supported_currencies:
    StoreSettingsCoreSchema.shape.supported_currencies.default(["NGN"]),
  business: StoreSettingsCoreSchema.shape.business.default(null),
  created_at: StoreSettingsCoreSchema.shape.created_at,
  updated_at: StoreSettingsCoreSchema.shape.updated_at,
});

export const BookkeepingTransactionSchema = z.object({
  id: z.string().uuid(),
  business_id: z.string().uuid(),
  store_id: z.string().uuid().nullable().optional(),
  type: z.enum(["income", "expense"]),
  category: z.string().min(1).max(50),
  amount: z.number(),
  currency: z.string().length(3).default("NGN"),
  description: z.string().nullable().optional(),
  transaction_date: z.string().datetime(),
  reference_id: z.string().uuid().nullable().optional(),
  reference_type: z.string().nullable().optional(),
  receipt_url: z.string().nullable().optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type BookkeepingTransaction = z.infer<
  typeof BookkeepingTransactionSchema
>;

export function generateOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `ORD-${timestamp}${random}`;
}

export function generatePurchaseOrderNumber(): string {
  const timestamp = Date.now().toString().slice(-6);
  const random = Math.random().toString(36).substr(2, 4).toUpperCase();
  return `PO-${timestamp}${random}`;
}

export function generateSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function formatCurrency(
  amount: number,
  currency: string = "NGN",
): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: currency,
  }).format(amount);
}

export function calculateEligibleSubtotal(
  items: { product_id: string; lineTotal: number }[],
  discount: Pick<DiscountCode, "applies_to" | "product_ids">,
): number {
  if (discount.applies_to === "all") {
    return items.reduce((sum, item) => sum + item.lineTotal, 0);
  }
  return items
    .filter((item) => discount.product_ids.includes(item.product_id))
    .reduce((sum, item) => sum + item.lineTotal, 0);
}

export function calculateDiscount(
  subtotal: number,
  discountType: "percentage" | "fixed",
  discountValue: number,
): number {
  if (discountType === "percentage") {
    return (subtotal * discountValue) / 100;
  }
  return Math.min(discountValue, subtotal);
}

export function isDiscountValid(discount: DiscountCode): boolean {
  if (!discount.is_active) return false;

  if (discount.max_usage && discount.usage_count >= discount.max_usage) {
    return false;
  }

  if (discount.expires_at && new Date(discount.expires_at) < new Date()) {
    return false;
  }

  if (discount.starts_at && new Date(discount.starts_at) > new Date()) {
    return false;
  }

  return true;
}

export function createDefaultStoreSettings(
  userId: string,
  name: string,
  slug: string,
  businessId?: string,
): Omit<StoreSettings, "id" | "created_at" | "updated_at"> {
  return {
    user_id: userId,
    business_id: businessId || null,
    name,
    slug,
    is_live: false,
    sells_in_person: false,
    appearance: {
      description: "",
      cover_image: null,
      logo: null,
      accent_color: "",
      availability_profile_id: null,
      policies: {
        privacy_policy: "",
        refund_policy: "",
      },
      website: null,
      contact_email: "",
      contact_phone: "",
      location: "",
      social_links: {},
      business_hours: {
        monday: null,
        tuesday: null,
        wednesday: null,
        thursday: null,
        friday: null,
        saturday: null,
        sunday: null,
      },
      product_browsing_mode: "quick_view",
    },
    delivery: {
      default_carrier: "GIG",
      enable_tracking: true,
      shipping_note: "",
    },
    after_purchase: {
      thank_you_message:
        "Thank you for your purchase! We appreciate your business.",
      digital_download_instructions:
        "Your download link has been sent to your email.",
      follow_up_email_note:
        "A confirmation email will be sent to you shortly with order details.",
    },
    business: null,
    paystack_subaccount_code: null,
    supported_currencies: ["NGN"],
  };
}

export function createDefaultProduct(
  storeId: string,
): Omit<Product, "id" | "created_at" | "updated_at"> {
  return {
    store_id: storeId,
    name: "",
    description: "",
    price: 0,
    compare_at_price: null,
    currency: "NGN",
    currency_prices: {},
    type: "digital",
    subtype: null,
    status: "draft",
    variant_group_name: "Options",
    variant_ui_type: "pills",
    digital: {
      download_url: null,
      download_limit: null,
      file_type: null,
      delivery_type: null,
      asset: null,
      primary_format: null,
      has_sample: false,
      sample_url: null,
      page_count: null,
      files: {
        pdf_url: null,
        epub_url: null,
        mobi_url: null,
        pdf_asset: null,
        epub_asset: null,
        mobi_asset: null,
      },
    },
    physical: {
      weight: 0,
      requires_shipping: true,
      dimensions: { length: 0, width: 0, height: 0 },
    },
    service: {
      duration_minutes: 0,
      location: null,
      availability: null,
      approval_required: false,
    },
    membership: {
      billing_cycle: "monthly",
      tier_name: "",
      benefits: [],
      renewal_reminder_days: 7,
    },
    bundle: {
      pricing_mode: "fixed",
      discount_percentage: null,
      product_ids: [],
    },
    donation: {
      suggested_amount: 0,
      allow_custom_amount: true,
    },
    allow_custom_price: false,
    cover_image: null,
    images: [],
    category_ids: [],
    marketplace_category_id: null,
    supplier_ids: [],
    is_sellable: true,
    created_by: null,
    storefront_enabled: true,
    pos_enabled: true,
    marketplace_enabled: true,
    digital_link_expiry_hours: null,
    availability_profile_id: null,
    circle_link: null,
    module_link: null,
    stock: null,
    orders_count: 0,
    variants: [],
    options_config: [],
    is_pre_order: false,
    pre_order_release_date: null,
    pre_order_message: null,
    pre_order_deposit_pct: null,
    after_purchase_redirect_url: null,
    checkout: null,
    prep_time_minutes: null,
    is_available_today: true,
    available_branch_ids: null,
    lead_time_hours: null,
    unit_id: null,
    unit_of_sale: "piece",
    quantity_step: 1,
    min_order_quantity: 1,
    max_order_quantity: null,
    allergens: null,
    has_prep_time: false,
  };
}

export type AvailabilityProfile = z.infer<typeof AvailabilityProfileSchema>;
export type StoreCategory = z.infer<typeof StoreCategorySchema>;
export type StoreCustomer = z.infer<typeof StoreCustomerSchema>;
export type StoreReview = z.infer<typeof StoreReviewSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Order = z.infer<typeof OrderSchema>;
export type StoreSettings = z.infer<typeof StoreSettingsSchema>;
export type DiscountCode = z.infer<typeof DiscountCodeSchema>;
export type ServiceBooking = z.infer<typeof ServiceBookingSchema>;
export type ProductCircleLink = z.infer<typeof ProductCircleLinkSchema>;
export type ProductModuleLink = z.infer<typeof ProductModuleLinkSchema>;

export const PermissionSchema = z.object({
  resource: z.string(),
  actions: z.array(z.string()),
});

export const RoleSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid().nullable(), // Null for system roles
  name: z.string().min(1).max(100),
  is_system: z.boolean().default(false),
  permissions: z.array(PermissionSchema).default([]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const TeamMemberSchema = z.object({
  id: z.string().uuid(),
  owner_id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  role_id: z.string().uuid(),
  status: z.enum(["pending", "accepted", "expired"]),
  email: z.string().email(),
  invited_at: z.string().datetime(),
  joined_at: z.string().datetime().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type Permission = z.infer<typeof PermissionSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
