import { SupabaseClient } from "@supabase/supabase-js";
import crypto, { randomUUID } from "crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { generateQRCode } from "../utils/tickets";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";
import { StorageService } from "./storage.service";
import { getR2Client, R2_BUCKET_NAME, R2_PUBLIC_URL } from "../config/r2";
import type { FeeBearer } from "../types/payment";
import type {
  CheckoutFxEvidence,
  CheckoutPricingSnapshot,
  PaymentMetadata,
} from "../types/webhook";
import {
  StoreSettings,
  Product,
  Order,
  DiscountCode,
  DiscountCodeSchema,
  StoreCustomer,
  StoreReview,
  StoreCategory,
  StoreBranch,
  StoreQrCode,
  StoreMenu,
  StoreUnit,
  ModifierGroup,
  ModifierOption,
  ModifierGroupUpsert,
  ProductBranchOverride,
  createDefaultStoreSettings,
  generateOrderNumber,
  generatePurchaseOrderNumber,
  generateSlug,
  calculateDiscount,
  isDiscountValid,
  calculateEligibleSubtotal,
} from "../types/store";
import {
  deriveFlutterwaveMerchantShare,
  resolveCustomerCharge,
  verifyPaymentAmount,
  type ChargeContext,
  resolvePaymentProvider,
} from "../utils/payment/fees";
import { PaymentProviderFactory } from "../utils/payment";
import type { PaymentProviderName } from "../utils/payment";
import type { SupportedCurrency, VirtualAccount } from "../utils/payment";
import type { NormalisedPaymentData } from "../utils/payment/types";
import type { PendingCheckout } from "./pending-checkout.service";
import {
  resolvePaymentAmount,
  resolvePaymentConversion,
  type PaymentConversion,
} from "../utils/currency-rates.util";
import {
  getCurrencyOverride,
  normalizeSupportedCurrencies,
  resolveUnitPrice,
  validateCurrencyPrices,
} from "../utils/product-pricing.util";
import type { CurrencyPriceMap } from "../utils/product-pricing.util";
import {
  storeEmailService,
  type PaymentEmailSummary,
} from "../utils/storeEmails.util";
import {
  processProductImage,
  processProductImages,
  processStoreAppearanceImage,
  deleteStorageImage,
} from "../utils/storage.util";
import { AvailabilityService } from "./availability.service";
import {
  moduleRegistryService,
  type EntityMeta,
} from "./module-registry.service";
import type { ModuleLinkTypeValue } from "../types/store";
import { BookingService } from "./booking.service";
import { DeliveryService } from "./delivery/delivery.service";
import { BookkeepingService } from "./bookkeeping.service";
import { supabaseAdmin } from "../config/supabase";
import { BankingService } from "./banking.service";
import { ApprovalWorkflowService } from "./approval-workflow.service";
import {
  createPaystackTransferRecipient,
  initiatePaystackTransfer,
  getPaystackTransfer,
} from "../utils/paystack.util";
import pendingCheckoutService from "./pending-checkout.service";
import {
  DISCOUNT_COLUMNS,
  DiscountService,
  type DiscountEvaluation,
  type DiscountEvaluationItem,
  type AppliedDiscount,
} from "./discount.service";

// A "pay what you want" buyer may pay nothing (free checkout), but any non-zero
// amount must meet this minimum. Kept in sync with the storefront input.
const CUSTOM_PRICE_PAID_MINIMUM = 100;
const MAX_PRODUCT_FILE_SIZE_MB = 50;
const MAX_PRODUCT_FILE_SIZE = MAX_PRODUCT_FILE_SIZE_MB * 1024 * 1024;
const ALLOWED_PRODUCT_FILE_MIME_TYPES = [
  "application/pdf",
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "audio/mpeg",
  "audio/mp3",
  "video/mp4",
  "application/epub+zip",
  "application/x-mobipocket-ebook",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
];

/** The status an order can hold while/after a pre-order product is released. */
type ReleasedOrderStatus = "pre_order" | "paid" | "fulfilled";

/** The subset of an order item the release flow reads and rewrites. */
interface ReleasableOrderItem {
  product_id?: string;
  product_type?: string;
  is_pre_order?: boolean;
  [key: string]: unknown;
}

/** The subset of an order row the release flow needs. */
interface ReleasableOrder {
  id: string;
  payment_reference?: string;
  items?: ReleasableOrderItem[];
}

/** The product fields the release flow needs to deliver and notify. */
interface ReleasableProduct {
  id: string;
  type: string;
  name: string;
  pre_order_message: string | null;
}

/** A single line item as submitted from the checkout form. */
interface CheckoutItemInput {
  product_id: string;
  variant_id?: string | null;
  quantity: number;
  price?: number | null;
  slot?: { startTime: string; endTime: string; date: string } | null;
  selected_modifiers?: Array<{ modifier_option_id: string; quantity?: number }>;
  note?: string | null;
}

/** The full payload shared by the card and bank-transfer checkout entry points. */
interface CheckoutInput {
  store_id: string;
  payment_reference?: string;
  user_id?: string;
  selected_plan_id?: string;
  customer: { name: string; email: string; phone?: string; address?: string };
  items: CheckoutItemInput[];
  discount_code?: string;
  callback_url?: string;
  delivery_method_id?: string;
  delivery_fee?: number;
  delivery_provider?: string;
  delivery_service_code?: string;
  delivery_courier_id?: string;
  delivery_city?: string;
  delivery_state?: string;
  delivery_zip?: string;
  currency?: string;
  // Food store fulfilment (PRD Phase 4)
  fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
  branch_id?: string;
  utensils_requested?: boolean;
  notes?: string;
  // Opaque code from a scanned store QR (e.g. "Table 12") — resolved
  // server-side in resolveStoreCharge, never trusted as sent. Resolving it
  // overrides branch_id and forces fulfillment_type to "dine_in".
  qr_code?: string;
}

/** A cart line item with its price fully server-resolved (branch override,
 *  variant adjustment, modifier deltas) — the shape both online checkout
 *  and POS orders price identically via resolveOrderItemPricing. */
interface ResolvedOrderItem {
  product_id: string;
  product_name: string;
  variant_id: string | null;
  variant_name: string | null;
  variant_price_adjustment: number;
  // Structured multi-axis breakdown (e.g. [{name:"Size",value:"250g"},
  // {name:"Spice Level",value:"Extra Hot"}]) — empty for legacy variants
  // that predate the options column, or when no variant was selected.
  variant_options: Array<{ name: string; value: string }>;
  quantity: number;
  price: number;
  slot: { startTime: string; endTime: string; date: string } | null;
  selected_modifiers: unknown[];
  note: string | null;
}

/** Subtotal → discount → tax → service charge → total, computed once and
 *  shared by every order-creation path (see computeOrderPricing). */
interface OrderPricing {
  subtotal: number;
  discount: number;
  discountDetails: AppliedDiscount[];
  deliveryFee: number;
  taxRate: number;
  taxAmount: number;
  serviceChargeRate: number;
  serviceChargeAmount: number;
  total: number;
}

/** Everything needed to charge a resolved cart, shared across payment channels. */
interface ResolvedStoreCharge {
  provider: ReturnType<typeof PaymentProviderFactory.getProvider>;
  storeCurrency: SupportedCurrency;
  reference?: string;
  subaccountCode?: string;
  feeBearer: FeeBearer;
  flwSubaccountId?: string;
  convertedTotal: number;
  totalToCharge: number;
  platformFee: number;
  gatewayFee: number;
  flwMerchantAmount: number;
  metadata: PaymentMetadata;
}

/**
 * Store Service
 * Class-based service for all Store operations
 */
// ────────────────────────────────────────────────────────────────────────────
// Explicit column lists for high-traffic queries (Phase 0.5 — egress reduction).
// Each string names only the columns the downstream code actually reads.
// ────────────────────────────────────────────────────────────────────────────

/** Columns for public product listings — excludes sensitive download URLs (nullified by transformToPublicProduct anyway). */
export const PRODUCT_PUBLIC_COLUMNS = [
  "id",
  "store_id",
  "name",
  "description",
  "price",
  "cost",
  "barcode",
  "compare_at_price",
  "currency",
  "currency_prices",
  "type",
  "subtype",
  "status",
  "variant_group_name",
  "variant_ui_type",
  "options_config",
  "physical",
  "service",
  "membership",
  "bundle",
  "donation",
  "cover_image",
  "images",
  "stock",
  "orders_count",
  "allow_custom_price",
  "created_at",
  "updated_at",
  "marketplace_category_id",
  "availability_profile_id",
  "is_pre_order",
  "pre_order_release_date",
  "pre_order_message",
  "pre_order_deposit_pct",
  "after_purchase_redirect_url",
  "is_sellable",
  "created_by",
  "storefront_enabled",
  "pos_enabled",
  "marketplace_enabled",
  "digital_link_expiry_hours",
  "prep_time_minutes",
  "is_available_today",
  "available_branch_ids",
  "lead_time_hours",
  "unit_id",
  "unit_of_sale",
  "quantity_step",
  "min_order_quantity",
  "max_order_quantity",
  "allergens",
  "has_prep_time",
].join(", ");

/** Order columns for list views — excludes `items` JSON (fetched on detail). */
const ORDER_LIST_COLUMNS = [
  "id",
  "store_id",
  "user_id",
  "order_number",
  "customer_name",
  "customer_email",
  "customer_phone",
  "customer_address",
  "items",
  "subtotal",
  "discount",
  "discount_code",
  "discount_details",
  "delivery_fee",
  "tax_amount",
  "service_charge_amount",
  "total",
  "currency",
  "status",
  "payment_reference",
  "shipping_carrier",
  "shipping_tracking_number",
  "shipping_status",
  "shipped_at",
  "delivered_at",
  "notes",
  "fulfillment_type",
  "branch_id",
  "utensils_requested",
  "qr_code_id",
  "location_label",
  "created_at",
  "updated_at",
  "fulfilled_at",
].join(", ");

/** Variant columns — matches the existing getProductVariants explicit select. */
const VARIANT_COLUMNS = [
  "id",
  "name",
  "group_name",
  "group_ui_type",
  "options",
  "price_adjustment",
  "compare_at_price",
  "cost",
  "stock",
  "sku",
  "barcode",
  "weight",
  "color_value",
  "is_active",
  "position",
  "created_at",
].join(", ");

/** Upper bound on modifier groups returned per store (egress cap). */
const MODIFIER_GROUP_FETCH_LIMIT = 500;

/** Modifier group columns — name them so reads don't drag back JSONB `options`. */
const MODIFIER_GROUP_COLUMNS = [  "id",
  "store_id",
  "name",
  "selection_type",
  "min_selections",
  "max_selections",
  "position",
  "kind",
  "description",
  "branch_ids",
  "created_at",
  "updated_at",
].join(", ");

/**
 * Full modifier group columns including the JSONB `options` array — used
 * only for single-group reads where the payload is actually consumed.
 */
const MODIFIER_GROUP_DETAIL_COLUMNS = `${MODIFIER_GROUP_COLUMNS}, options`;

interface ProductDashboardMetricRow {
  units_sold: number | string | null;
  revenue: number | string | null;
  customer_count: number | string | null;
  refunded_order_count: number | string | null;
  pre_order_count: number | string | null;
  last_sale_at: string | null;
}

interface ProductDashboardMetrics {
  units_sold: number;
  revenue: number;
  customer_count: number;
  refunded_order_count: number;
  pre_order_count: number;
  last_sale_at: string | null;
  service?: { bookings: number; no_shows: number };
}

type SupplierPayload = {
  name: string;
  code?: string | null;
  contact_person?: string;
  email?: string;
  phone?: string;
  category?: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
  website?: string | null;
  payment_terms?: "Net 15" | "Net 30" | "Net 60" | "Due on Receipt" | "Cash on Delivery";
  bank_name?: string | null;
  // The Paystack bank code, not the display name — needed to actually
  // create a transfer recipient when paying this vendor from the wallet
  // (see StoreService.executeBillTransfer). bank_name alone can't do that.
  bank_code?: string | null;
  account_number?: string | null;
  account_name?: string | null;
  notes?: string | null;
  is_active?: boolean;
};

type SupplierProductPayload = {
  product_id: string;
  variant_id?: string | null;
  supplier_sku?: string | null;
  supplier_product_name?: string | null;
  unit_cost?: number | null;
  minimum_order_quantity?: number;
  lead_time_days?: number | null;
  is_preferred?: boolean;
  status?: "active" | "inactive";
};

type StockReceiptLinePayload = {
  product_id?: string | null;
  variant_id?: string | null;
  purchase_order_line_id?: string | null;
  description?: string | null;
  quantity_received: number;
  quantity_rejected?: number;
  rejection_reason?: "damaged" | "wrong_item" | "short_shipped" | "expired_on_arrival" | "other" | null;
  unit_cost: number;
  tax_rate?: number;
  discount?: number;
  batch_number?: string | null;
  expiry_date?: string | null;
  manufacture_date?: string | null;
  serial_number?: string | null;
  notes?: string | null;
};

type PurchaseOrderLinePayload = {
  product_id?: string | null;
  variant_id?: string | null;
  description?: string | null;
  quantity_ordered: number;
  unit_cost: number;
  tax_rate?: number;
  discount?: number;
  notes?: string | null;
};

export class StoreService {
  private storageService: StorageService;

  constructor(private supabase: SupabaseClient) {
    this.storageService = new StorageService(supabase);
  }

  private getInventoryClient(): SupabaseClient {
    return supabaseAdmin || this.supabase;
  }

  async listSuppliers(storeId: string, activeOnly = false) {
    await this.getStoreById(storeId);
    let query = this.supabase
      .from("suppliers")
      .select("id, store_id, name, code, contact_person, email, phone, category, address, city, state, country, website, payment_terms, bank_name, bank_code, account_number, account_name, notes, is_active, created_at, updated_at")
      .eq("store_id", storeId)
      .order("name", { ascending: true });
    if (activeOnly) query = query.eq("is_active", true);
    const { data, error } = await query;
    if (error) throw error;

    const supplierIds = (data ?? []).map((s) => s.id);
    let billAggRows: Array<{ supplier_id: string; amount: number; paid_amount: number; status: string }> = [];
    let supplierProductRows: Array<{ supplier_id: string; product_id: string }> = [];
    if (supplierIds.length > 0) {
      const [billAgg, supplierProducts] = await Promise.all([
        this.supabase
          .from("supplier_bills")
          .select("supplier_id, amount, paid_amount, status")
          .eq("store_id", storeId)
          .in("supplier_id", supplierIds),
        this.supabase
          .from("supplier_products")
          .select("supplier_id, product_id")
          .eq("store_id", storeId)
          .eq("status", "active")
          .in("supplier_id", supplierIds),
      ]);
      if (billAgg.error && billAgg.error.code !== "42P01") throw billAgg.error;
      if (supplierProducts.error) throw supplierProducts.error;
      billAggRows = billAgg.data ?? [];
      supplierProductRows = supplierProducts.data ?? [];
    }

    const spendBySupplier = new Map<string, { total_spend: number; outstanding_payable: number }>();
    for (const bill of billAggRows) {
      const entry = spendBySupplier.get(bill.supplier_id) || { total_spend: 0, outstanding_payable: 0 };
      entry.total_spend += Number(bill.amount || 0);
      if (bill.status !== "cancelled") {
        entry.outstanding_payable += Math.max(Number(bill.amount || 0) - Number(bill.paid_amount || 0), 0);
      }
      spendBySupplier.set(bill.supplier_id, entry);
    }

    const productCountBySupplier = new Map<string, Set<string>>();
    for (const row of supplierProductRows) {
      const products = productCountBySupplier.get(row.supplier_id) ?? new Set<string>();
      products.add(row.product_id);
      productCountBySupplier.set(row.supplier_id, products);
    }

    return (data ?? []).map((supplier) => {
      const agg = spendBySupplier.get(supplier.id) || { total_spend: 0, outstanding_payable: 0 };
      return {
        ...supplier,
        product_count: productCountBySupplier.get(supplier.id)?.size ?? 0,
        total_spend: agg.total_spend,
        outstanding_payable: agg.outstanding_payable,
      };
    });
  }

  async createSupplier(storeId: string, payload: SupplierPayload) {
    await this.getStoreById(storeId);
    const { data, error } = await this.supabase
      .from("suppliers")
      .insert({ store_id: storeId, ...payload })
      .select("id, store_id, name, code, contact_person, email, phone, category, address, city, state, country, website, payment_terms, bank_name, bank_code, account_number, account_name, notes, is_active, created_at, updated_at")
      .single();
    if (error) throw error;
    return data;
  }

  async updateSupplier(
    storeId: string,
    supplierId: string,
    payload: Partial<SupplierPayload>,
  ) {
    await this.getStoreById(storeId);
    const { data, error } = await this.supabase
      .from("suppliers")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", supplierId)
      .eq("store_id", storeId)
      .select("id, store_id, name, code, contact_person, email, phone, category, address, city, state, country, website, payment_terms, bank_name, bank_code, account_number, account_name, notes, is_active, created_at, updated_at")
      .single();
    if (error) throw error;
    return data;
  }

  async deleteSupplier(storeId: string, supplierId: string): Promise<void> {
    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers")
      .select("id")
      .eq("id", supplierId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (supplierError) throw supplierError;
    if (!supplier) throw new Error("Supplier not found");

    const { count, error: referenceError } = await this.supabase
      .from("supplier_products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId);
    if (referenceError) throw referenceError;
    if ((count || 0) > 0) {
      const error = new Error("Supplier is assigned to products and cannot be deleted");
      Object.assign(error, { statusCode: 409 });
      throw error;
    }

    const { error } = await this.supabase
      .from("suppliers")
      .delete()
      .eq("id", supplierId)
      .eq("store_id", storeId);
    if (error) throw error;
  }

  async getSupplierDashboard(storeId: string, supplierId: string) {
    await this.getStoreById(storeId);
    const { data: supplier, error: supplierError } = await this.supabase.from("suppliers")
      .select("id, name, code, contact_person, email, phone, category, address, city, state, country, website, payment_terms, bank_name, bank_code, account_number, account_name, notes, is_active, created_at, updated_at")
      .eq("id", supplierId).eq("store_id", storeId).single();
    if (supplierError) throw supplierError;
    const [products, bills, movements, receipts] = await Promise.all([
      this.supabase.from("supplier_products").select("id, supplier_id, product_id, variant_id, supplier_sku, supplier_product_name, unit_cost, minimum_order_quantity, lead_time_days, is_preferred, last_purchase_cost, last_received_at, status, product:products(id, name, price, cost, stock, created_at, is_sellable)").eq("store_id", storeId).eq("supplier_id", supplierId).order("is_preferred", { ascending: false }),
      this.supabase.from("supplier_bills").select("id, bill_number, invoice_number, amount, paid_amount, currency, issue_date, due_date, status, items_count, notes, created_at").eq("store_id", storeId).eq("supplier_id", supplierId).order("issue_date", { ascending: false }).limit(100),
      this.supabase.from("stock_movements").select("id, product_id, quantity_change, reason, effective_at, created_at, unit_cost, batch_number, expiry_date, product:products(name)").eq("store_id", storeId).eq("supplier_id", supplierId).order("effective_at", { ascending: false }).limit(100),
      this.supabase.from("stock_receipts").select("id, branch_id, status, received_at, subtotal, tax, total, notes, created_at").eq("store_id", storeId).eq("supplier_id", supplierId).order("received_at", { ascending: false }).limit(50),
    ]);
    if (products.error) throw products.error;
    if (bills.error && bills.error.code !== "42P01") throw bills.error;
    if (movements.error) throw movements.error;
    if (receipts.error) throw receipts.error;
    const billRows = bills.data || [];
    const supplierProducts = products.data || [];
    return {
      supplier,
      products: supplierProducts.map((mapping) => ({
        ...(Array.isArray(mapping.product) ? mapping.product[0] : mapping.product),
        supplier_product: {
          id: mapping.id,
          variant_id: mapping.variant_id,
          supplier_sku: mapping.supplier_sku,
          supplier_product_name: mapping.supplier_product_name,
          unit_cost: mapping.unit_cost,
          minimum_order_quantity: mapping.minimum_order_quantity,
          lead_time_days: mapping.lead_time_days,
          is_preferred: mapping.is_preferred,
          last_purchase_cost: mapping.last_purchase_cost,
          last_received_at: mapping.last_received_at,
          status: mapping.status,
        },
      })),
      bills: billRows,
      receipts: receipts.data || [],
      activities: (movements.data || []).map((movement) => ({ ...movement, type: "stock_received", title: "Stock movement" })),
      summary: {
        product_count: new Set(supplierProducts.map((mapping) => mapping.product_id)).size,
        total_spend: billRows.reduce((sum, bill) => sum + Number(bill.amount || 0), 0),
        outstanding_payable: billRows
          .filter((bill) => bill.status !== "cancelled")
          .reduce((sum, bill) => sum + Math.max(Number(bill.amount || 0) - Number(bill.paid_amount || 0), 0), 0),
      },
    };
  }

  async createSupplierProduct(
    storeId: string,
    supplierId: string,
    payload: SupplierProductPayload,
  ) {
    await this.assertSupplierAndProductBelongToStore(
      storeId,
      supplierId,
      payload.product_id,
      payload.variant_id,
    );
    const { data, error } = await this.supabase
      .from("supplier_products")
      .insert({ store_id: storeId, supplier_id: supplierId, ...payload })
      .select("id, store_id, supplier_id, product_id, variant_id, supplier_sku, supplier_product_name, unit_cost, minimum_order_quantity, lead_time_days, is_preferred, last_purchase_cost, last_received_at, status, created_at, updated_at")
      .single();
    if (error) throw error;
    return data;
  }

  async updateSupplierProduct(
    storeId: string,
    supplierId: string,
    supplierProductId: string,
    payload: Partial<Omit<SupplierProductPayload, "product_id" | "variant_id">>,
  ) {
    const { data, error } = await this.supabase
      .from("supplier_products")
      .update({ ...payload, updated_at: new Date().toISOString() })
      .eq("id", supplierProductId)
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .select("id, store_id, supplier_id, product_id, variant_id, supplier_sku, supplier_product_name, unit_cost, minimum_order_quantity, lead_time_days, is_preferred, last_purchase_cost, last_received_at, status, created_at, updated_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Supplier product not found"), { statusCode: 404 });
    return data;
  }

  async deleteSupplierProduct(
    storeId: string,
    supplierId: string,
    supplierProductId: string,
  ): Promise<void> {
    const { data, error } = await this.supabase
      .from("supplier_products")
      .delete()
      .eq("id", supplierProductId)
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Supplier product not found"), { statusCode: 404 });
  }

  async createStockReceipt(
    storeId: string,
    supplierId: string,
    payload: {
      branch_id?: string | null;
      received_at?: string;
      notes?: string | null;
      purchase_order_id?: string | null;
      lines: StockReceiptLinePayload[];
    },
    userId: string,
  ) {
    const { data: receipt, error } = await this.supabase.rpc(
      "create_completed_stock_receipt",
      {
        p_store_id: storeId,
        p_supplier_id: supplierId,
        p_branch_id: payload.branch_id ?? null,
        p_received_at: payload.received_at ?? new Date().toISOString(),
        p_received_by: userId,
        p_notes: payload.notes ?? null,
        p_lines: payload.lines,
        p_purchase_order_id: payload.purchase_order_id ?? null,
      },
    );
    if (error) {
      if (error.message?.includes("Received quantity exceeds")) {
        throw Object.assign(new Error("Received quantity exceeds the remaining ordered quantity on one or more purchase order lines"), { statusCode: 400 });
      }
      throw error;
    }

    const receiptId = Array.isArray(receipt) ? receipt[0]?.id : receipt?.id;
    if (!receiptId) throw new Error("Receipt was created without an identifier");
    return this.getStockReceipt(storeId, supplierId, receiptId);
  }

  async createPurchaseOrder(
    storeId: string,
    payload: { supplier_id: string; branch_id?: string | null; order_date?: string | null; expected_delivery_date?: string | null; notes?: string | null; lines: PurchaseOrderLinePayload[] },
    userId: string,
  ) {
    const { data: supplier, error: supplierError } = await this.supabase.from("suppliers").select("id").eq("id", payload.supplier_id).eq("store_id", storeId).maybeSingle();
    if (supplierError) throw supplierError;
    if (!supplier) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });
    if (payload.branch_id) {
      const { data: branch, error } = await this.supabase.from("store_branches").select("id").eq("id", payload.branch_id).eq("store_id", storeId).maybeSingle();
      if (error) throw error;
      if (!branch) throw Object.assign(new Error("Branch not found"), { statusCode: 400 });
    }
    const subtotal = payload.lines.reduce((sum, line) => sum + line.quantity_ordered * line.unit_cost - (line.discount ?? 0), 0);
    const tax = payload.lines.reduce((sum, line) => sum + ((line.quantity_ordered * line.unit_cost - (line.discount ?? 0)) * (line.tax_rate ?? 0)) / 100, 0);
    const { data: order, error: orderError } = await this.supabase.from("purchase_orders").insert({
      store_id: storeId, supplier_id: payload.supplier_id, branch_id: payload.branch_id ?? null,
      order_number: generatePurchaseOrderNumber(), order_date: payload.order_date || new Date().toISOString().slice(0, 10),
      expected_delivery_date: payload.expected_delivery_date ?? null,
      subtotal: Math.max(subtotal, 0), tax: Math.max(tax, 0), total: Math.max(subtotal + tax, 0), notes: payload.notes ?? null, created_by: userId,
    }).select("id, store_id, supplier_id, branch_id, status, sent_at, received_at, order_number, order_date, expected_delivery_date, subtotal, tax, total, notes, created_by, created_at, updated_at").single();
    if (orderError) throw orderError;
    const rows = payload.lines.map((line) => ({ purchase_order_id: order.id, ...line, tax_rate: line.tax_rate ?? 0, discount: line.discount ?? 0 }));
    const { error: lineError } = await this.supabase.from("purchase_order_lines").insert(rows);
    if (lineError) throw lineError;
    return this.getPurchaseOrder(storeId, order.id);
  }

  async listPurchaseOrders(storeId: string, status?: string, page = 1, pageSize = 20) {
    const from = (page - 1) * pageSize;
    let query = this.supabase.from("purchase_orders").select("id, store_id, supplier_id, branch_id, status, sent_at, received_at, order_number, order_date, expected_delivery_date, subtotal, tax, total, notes, created_by, created_at, updated_at, supplier:suppliers(id, name), branch:store_branches(id, name), lines:purchase_order_lines(id, product_id, variant_id, description, quantity_ordered, quantity_received, unit_cost, tax_rate, discount, notes)", { count: "exact" }).eq("store_id", storeId).order("created_at", { ascending: false }).range(from, from + pageSize - 1);
    if (status) query = query.eq("status", status);
    const { data, error, count } = await query;
    if (error) throw error;
    return { purchase_orders: data ?? [], total: count ?? 0, page, page_size: pageSize };
  }

  async getPurchaseOrder(storeId: string, purchaseOrderId: string) {
    const { data, error } = await this.supabase.from("purchase_orders").select("id, store_id, supplier_id, branch_id, status, sent_at, received_at, order_number, order_date, expected_delivery_date, subtotal, tax, total, notes, created_by, created_at, updated_at, supplier:suppliers(id, name), branch:store_branches(id, name), lines:purchase_order_lines(id, product_id, variant_id, description, quantity_ordered, quantity_received, unit_cost, tax_rate, discount, notes)").eq("id", purchaseOrderId).eq("store_id", storeId).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Purchase order not found"), { statusCode: 404 });
    return data;
  }

  async updatePurchaseOrder(storeId: string, purchaseOrderId: string, updates: { status?: "draft" | "cancelled"; expected_delivery_date?: string | null; notes?: string | null }) {
    const { data, error } = await this.supabase.from("purchase_orders").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", purchaseOrderId).eq("store_id", storeId).select("id, store_id, supplier_id, branch_id, status, sent_at, received_at, order_number, order_date, expected_delivery_date, subtotal, tax, total, notes, created_by, created_at, updated_at").maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Purchase order not found"), { statusCode: 404 });
    return data;
  }

  // Marking a draft "sent" is meaningful — it's the point the supplier is
  // actually told about the order — so this owns both the email and the
  // status transition, rather than folding "sent" into the generic
  // updatePurchaseOrder above where it'd be easy to flip silently with no
  // one on the other end ever finding out.
  async sendPurchaseOrder(storeId: string, purchaseOrderId: string) {
    const order = await this.getPurchaseOrder(storeId, purchaseOrderId);
    if (order.status !== "draft") {
      throw Object.assign(new Error("Only draft purchase orders can be sent"), { statusCode: 400 });
    }

    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers").select("name, email").eq("id", order.supplier_id).eq("store_id", storeId).single();
    if (supplierError) throw supplierError;
    const supplierEmail = (supplier?.email || "").trim();
    if (!supplierEmail) {
      throw Object.assign(new Error("This supplier has no email on file — add one before sending"), { statusCode: 400 });
    }

    const { data: store, error: storeError } = await this.supabase
      .from("stores").select("name, business_id").eq("id", storeId).single();
    if (storeError) throw storeError;

    const productIds = [...new Set((order.lines ?? []).map((line: any) => line.product_id).filter(Boolean))];
    const { data: products } = productIds.length
      ? await this.supabase.from("products").select("id, name").in("id", productIds as string[])
      : { data: [] as { id: string; name: string }[] };
    const productNameById = new Map((products ?? []).map((product: any) => [product.id, product.name]));

    const lines = (order.lines ?? []).map((line: any) => ({
      description: line.product_id
        ? (productNameById.get(line.product_id) ?? "Unknown product")
        : (line.description ?? "Item"),
      quantity: line.quantity_ordered,
      unitCost: line.unit_cost,
      total: line.quantity_ordered * line.unit_cost - (line.discount ?? 0),
    }));

    const emailSent = await storeEmailService.sendPurchaseOrderEmail({
      supplierEmail,
      supplierName: supplier.name,
      storeName: store?.name ?? "Your store",
      businessId: store?.business_id ?? undefined,
      orderNumber: order.order_number,
      orderDate: order.order_date,
      expectedDeliveryDate: order.expected_delivery_date,
      locationName: (order as any).branch?.name ?? null,
      notes: order.notes,
      currency: "NGN",
      lines,
      subtotal: order.subtotal,
      tax: order.tax,
      total: order.total,
    });

    const { data, error } = await this.supabase
      .from("purchase_orders")
      .update({ status: "sent", sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("id", purchaseOrderId).eq("store_id", storeId)
      .select("id").maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Purchase order not found"), { statusCode: 404 });

    const updated = await this.getPurchaseOrder(storeId, purchaseOrderId);
    return { ...updated, email_sent: emailSent };
  }

  async listStockReceipts(
    storeId: string,
    supplierId: string,
    page = 1,
    pageSize = 20,
  ) {
    const from = (page - 1) * pageSize;
    const { data, error, count } = await this.supabase
      .from("stock_receipts")
      .select("id, store_id, supplier_id, branch_id, status, received_at, received_by, subtotal, tax, total, notes, created_at, updated_at", { count: "exact" })
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .order("received_at", { ascending: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    return { receipts: data ?? [], total: count ?? 0, page, page_size: pageSize };
  }

  private async getStockReceipt(
    storeId: string,
    supplierId: string,
    receiptId: string,
  ) {
    const { data, error } = await this.supabase
      .from("stock_receipts")
      .select("id, store_id, supplier_id, branch_id, status, received_at, received_by, subtotal, tax, total, notes, created_at, updated_at, lines:stock_receipt_lines(id, product_id, variant_id, description, quantity_received, quantity_rejected, rejection_reason, unit_cost, tax_rate, discount, batch_number, expiry_date, manufacture_date, serial_number, notes, created_at)")
      .eq("id", receiptId)
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .single();
    if (error) throw error;
    return data;
  }

  private async assertSupplierAndProductBelongToStore(
    storeId: string,
    supplierId: string,
    productId: string,
    variantId?: string | null,
  ): Promise<void> {
    const [supplier, product] = await Promise.all([
      this.supabase.from("suppliers").select("id").eq("id", supplierId).eq("store_id", storeId).maybeSingle(),
      this.supabase.from("products").select("id").eq("id", productId).eq("store_id", storeId).maybeSingle(),
    ]);
    if (supplier.error) throw supplier.error;
    if (product.error) throw product.error;
    if (!supplier.data) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });
    if (!product.data) throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    if (!variantId) return;

    const { data, error } = await this.supabase
      .from("product_variants")
      .select("id")
      .eq("id", variantId)
      .eq("product_id", productId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Variant not found for product"), { statusCode: 400 });
  }

  async createSupplierBill(
    storeId: string,
    supplierId: string,
    payload: {
      bill_number: string;
      invoice_number?: string | null;
      amount: number;
      currency: string;
      issue_date: string;
      due_date?: string | null;
      status: "draft" | "pending" | "approved" | "overdue" | "disputed" | "cancelled";
      items_count: number;
      notes?: string | null;
    },
    userId: string,
  ) {
    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers").select("id").eq("id", supplierId).eq("store_id", storeId).single();
    if (supplierError || !supplier) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });
    const { data, error } = await this.supabase.from("supplier_bills").insert({
      store_id: storeId,
      supplier_id: supplierId,
      ...payload,
      created_by: userId,
    }).select("id, bill_number, invoice_number, amount, paid_amount, currency, issue_date, due_date, status, items_count, notes, created_at").single();
    if (error) throw error;
    return data;
  }

  async updateSupplierBillStatus(
    storeId: string,
    supplierId: string,
    billId: string,
    status: "draft" | "pending" | "approved" | "overdue" | "disputed" | "cancelled",
  ) {
    const { data, error } = await this.supabase.from("supplier_bills")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", billId).eq("supplier_id", supplierId).eq("store_id", storeId)
      .select("id, bill_number, invoice_number, amount, paid_amount, currency, issue_date, due_date, status, items_count, notes, created_at").maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Supplier bill not found"), { statusCode: 404 });
    return data;
  }

  async listSupplierBills(storeId: string, supplierId: string, page = 1, pageSize = 20) {
    await this.getStoreById(storeId);
    const { data: supplier, error: sErr } = await this.supabase
      .from("suppliers").select("id").eq("id", supplierId).eq("store_id", storeId).single();
    if (sErr || !supplier) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const { data, error, count } = await this.supabase
      .from("supplier_bills")
      .select("id, bill_number, invoice_number, amount, paid_amount, currency, issue_date, due_date, status, items_count, notes, created_at", { count: "exact" })
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .order("issue_date", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return { bills: data ?? [], total: count ?? 0, page, page_size: pageSize };
  }

  async getSupplierBillItems(storeId: string, supplierId: string, billId: string) {
    const { data: bill, error: bErr } = await this.supabase
      .from("supplier_bills")
      .select("id")
      .eq("id", billId)
      .eq("supplier_id", supplierId)
      .eq("store_id", storeId)
      .single();
    if (bErr || !bill) throw Object.assign(new Error("Supplier bill not found"), { statusCode: 404 });

    const { data, error } = await this.supabase
      .from("supplier_bill_items")
      .select("id, bill_id, description, quantity, unit_price, total, created_at, updated_at")
      .eq("bill_id", billId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return data ?? [];
  }

  async addSupplierBillItem(
    storeId: string,
    supplierId: string,
    billId: string,
    payload: { description: string; quantity: number; unit_price: number },
  ) {
    const { data: bill, error: bErr } = await this.supabase
      .from("supplier_bills")
      .select("id")
      .eq("id", billId)
      .eq("supplier_id", supplierId)
      .eq("store_id", storeId)
      .single();
    if (bErr || !bill) throw Object.assign(new Error("Supplier bill not found"), { statusCode: 404 });

    const { data, error } = await this.supabase
      .from("supplier_bill_items")
      .insert({ bill_id: billId, ...payload })
      .select("id, bill_id, description, quantity, unit_price, total, created_at, updated_at")
      .single();
    if (error) throw error;

    const { count } = await this.supabase
      .from("supplier_bill_items")
      .select("id", { count: "exact", head: true })
      .eq("bill_id", billId);
    await this.supabase
      .from("supplier_bills")
      .update({ items_count: count ?? 0, updated_at: new Date().toISOString() })
      .eq("id", billId);

    return data;
  }

  async listSupplierPayments(storeId: string, supplierId: string, page = 1, pageSize = 20) {
    await this.getStoreById(storeId);
    const { data: supplier, error: sErr } = await this.supabase
      .from("suppliers").select("id").eq("id", supplierId).eq("store_id", storeId).single();
    if (sErr || !supplier) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });

    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    const { data, error, count } = await this.supabase
      .from("supplier_payments")
      .select("id, store_id, supplier_id, bill_id, amount, payment_date, method, reference, notes, status, created_by, created_at", { count: "exact" })
      .eq("store_id", storeId)
      .eq("supplier_id", supplierId)
      .order("payment_date", { ascending: false })
      .range(from, to);
    if (error) throw error;
    return { payments: data ?? [], total: count ?? 0, page, page_size: pageSize };
  }

  async createSupplierPayment(
    storeId: string,
    supplierId: string,
    payload: {
      bill_id?: string | null;
      amount: number;
      payment_date?: string;
      method: string;
      reference?: string | null;
      notes?: string | null;
      status?: "pending" | "successful" | "failed";
    },
    userId: string,
  ) {
    const { data, error } = await this.supabase.rpc("record_supplier_payment", {
      p_store_id: storeId,
      p_supplier_id: supplierId,
      p_bill_id: payload.bill_id ?? null,
      p_amount: payload.amount,
      p_payment_date: payload.payment_date ?? new Date().toISOString().split("T")[0],
      p_method: payload.method,
      p_reference: payload.reference ?? null,
      p_notes: payload.notes ?? null,
      p_created_by: userId,
      p_status: payload.status ?? "successful",
    });
    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  // ==========================================================================
  // Store-wide bills dashboard (Payments > Bill pay) — lists/creates bills
  // across every vendor, unlike the supplier-scoped methods above which back
  // the Vendor detail page. Both read/write the same supplier_bills tables.
  // ==========================================================================

  private static readonly BILL_SELECT_COLUMNS =
    "id, store_id, supplier_id, bill_number, invoice_number, category, amount, subtotal, tax_amount, paid_amount, currency, issue_date, due_date, status, approval_state, items_count, notes, created_at, updated_at";

  /**
   * A bill's stored status only moves to 'overdue' when something explicitly
   * sets it — there's no cron sweeping past-due bills. Compute the effective,
   * display-facing status instead of trusting the stored value: a payable
   * bill whose due date has passed reads as overdue regardless.
   */
  private withEffectiveBillStatus<T extends { status: string; due_date: string | null }>(
    bill: T,
    today: string,
  ): T {
    const isPayable = bill.status === "approved" || bill.status === "partially_paid";
    if (isPayable && bill.due_date && bill.due_date < today) {
      return { ...bill, status: "overdue" };
    }
    return bill;
  }

  async listBills(
    storeId: string,
    filters: {
      status?: string;
      category?: string;
      supplier_id?: string;
      search?: string;
      page?: number;
      page_size?: number;
    },
  ) {
    await this.getStoreById(storeId);
    const page = filters.page ?? 1;
    const pageSize = filters.page_size ?? 20;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let query = this.supabase
      .from("supplier_bills")
      .select(`${StoreService.BILL_SELECT_COLUMNS}, supplier:suppliers(id, name, email)`, { count: "exact" })
      .eq("store_id", storeId);

    if (filters.status) query = query.eq("status", filters.status);
    if (filters.category) query = query.eq("category", filters.category);
    if (filters.supplier_id) query = query.eq("supplier_id", filters.supplier_id);
    if (filters.search) {
      const term = filters.search.replace(/[%,]/g, "");
      query = query.or(`bill_number.ilike.%${term}%,invoice_number.ilike.%${term}%`);
    }

    const { data, error, count } = await query.order("issue_date", { ascending: false }).range(from, to);
    if (error) throw error;

    const today = new Date().toISOString().split("T")[0];
    const bills = (data ?? []).map((bill: any) => this.withEffectiveBillStatus(bill, today));
    return { bills, total: count ?? 0, page, page_size: pageSize };
  }

  async getBillById(storeId: string, billId: string) {
    const { data, error } = await this.supabase
      .from("supplier_bills")
      .select(`${StoreService.BILL_SELECT_COLUMNS}, supplier:suppliers(id, name, email, bank_name, bank_code, account_number, account_name)`)
      .eq("id", billId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error("Bill not found"), { statusCode: 404 });

    // A bill's own status stays 'approved' while its transfer is in
    // flight — surface the in-progress payment separately so a UI can
    // show "awaiting transfer approval" instead of offering to pay again.
    const { data: pendingPayment, error: pendingPaymentError } = await this.supabase
      .from("supplier_payments")
      .select("id, amount, status")
      .eq("bill_id", billId)
      .in("status", ["pending", "processing"])
      .maybeSingle();
    if (pendingPaymentError) throw pendingPaymentError;

    const today = new Date().toISOString().split("T")[0];
    return this.withEffectiveBillStatus({ ...data, pending_payment: pendingPayment ?? null } as any, today);
  }

  async getBillMetrics(storeId: string) {
    await this.getStoreById(storeId);

    const { data: bills, error } = await this.supabase
      .from("supplier_bills")
      .select("amount, paid_amount, status, due_date")
      .eq("store_id", storeId)
      .limit(5000);
    if (error) throw error;

    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 6);
    const startOfWeekStr = startOfWeek.toISOString().split("T")[0];
    const endOfWeekStr = endOfWeek.toISOString().split("T")[0];
    const monthStartStr = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split("T")[0];

    let outstanding_amount = 0, outstanding_count = 0;
    let due_this_week_amount = 0, due_this_week_count = 0;
    let overdue_amount = 0, overdue_count = 0;

    for (const bill of bills ?? []) {
      const balance = Math.max(Number(bill.amount || 0) - Number(bill.paid_amount || 0), 0);
      const isPayable = bill.status === "approved" || bill.status === "partially_paid";
      if (!isPayable) continue;

      outstanding_amount += balance;
      outstanding_count += 1;

      if (bill.due_date && bill.due_date >= startOfWeekStr && bill.due_date <= endOfWeekStr) {
        due_this_week_amount += balance;
        due_this_week_count += 1;
      }
      if (bill.due_date && bill.due_date < todayStr) {
        overdue_amount += balance;
        overdue_count += 1;
      }
    }

    // "Paid this month" reflects actual payment events, not bill.updated_at
    // (which changes on any edit) — pulled from the payments ledger instead.
    const { data: payments, error: paymentsError } = await this.supabase
      .from("supplier_payments")
      .select("amount")
      .eq("store_id", storeId)
      .eq("status", "successful")
      .gte("payment_date", monthStartStr);
    if (paymentsError) throw paymentsError;

    const paid_this_month_amount = (payments ?? []).reduce((sum, p) => sum + Number(p.amount || 0), 0);
    const paid_this_month_count = (payments ?? []).length;

    return {
      outstanding_amount,
      outstanding_count,
      due_this_week_amount,
      due_this_week_count,
      overdue_amount,
      overdue_count,
      paid_this_month_amount,
      paid_this_month_count,
    };
  }

  async createBillWithItems(
    storeId: string,
    payload: {
      supplier_id: string;
      bill_number: string;
      invoice_number?: string | null;
      category: string;
      currency: string;
      issue_date: string;
      due_date?: string | null;
      notes?: string | null;
      submit: boolean;
      items: Array<{ description: string; quantity: number; unit_price: number; tax_rate: number }>;
    },
    userId: string,
  ) {
    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers").select("id").eq("id", payload.supplier_id).eq("store_id", storeId).single();
    if (supplierError || !supplier) throw Object.assign(new Error("Supplier not found"), { statusCode: 404 });

    const subtotal = payload.items.reduce((sum, item) => sum + item.quantity * item.unit_price, 0);
    const taxAmount = payload.items.reduce(
      (sum, item) => sum + item.quantity * item.unit_price * (item.tax_rate / 100),
      0,
    );
    const amount = Math.round((subtotal + taxAmount) * 100) / 100;

    const status = payload.submit ? "pending" : "draft";
    const approvalState = payload.submit ? "pending" : "not_required";

    const { data: bill, error: billError } = await this.supabase
      .from("supplier_bills")
      .insert({
        store_id: storeId,
        supplier_id: payload.supplier_id,
        bill_number: payload.bill_number,
        invoice_number: payload.invoice_number ?? null,
        category: payload.category,
        amount,
        subtotal: Math.round(subtotal * 100) / 100,
        tax_amount: Math.round(taxAmount * 100) / 100,
        currency: payload.currency,
        issue_date: payload.issue_date,
        due_date: payload.due_date ?? null,
        status,
        approval_state: approvalState,
        items_count: payload.items.length,
        notes: payload.notes ?? null,
        created_by: userId,
      })
      .select(StoreService.BILL_SELECT_COLUMNS)
      .single();
    if (billError) throw billError;

    const { error: itemsError } = await this.supabase
      .from("supplier_bill_items")
      .insert(payload.items.map((item) => ({
        bill_id: bill.id,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        tax_rate: item.tax_rate,
      })));
    if (itemsError) throw itemsError;

    return bill;
  }

  async deleteBill(storeId: string, billId: string) {
    const { data: bill, error: fetchError } = await this.supabase
      .from("supplier_bills")
      .select("id, status")
      .eq("id", billId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!bill) throw Object.assign(new Error("Bill not found"), { statusCode: 404 });
    if (bill.status !== "draft" && bill.status !== "rejected") {
      throw Object.assign(new Error("Only draft or rejected bills can be deleted"), { statusCode: 400 });
    }

    const { error } = await this.supabase.from("supplier_bills").delete().eq("id", billId);
    if (error) throw error;
  }

  async approveBill(storeId: string, billId: string) {
    const { data: bill, error: fetchError } = await this.supabase
      .from("supplier_bills")
      .select("id, status")
      .eq("id", billId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!bill) throw Object.assign(new Error("Bill not found"), { statusCode: 404 });
    if (bill.status !== "pending") {
      throw Object.assign(new Error("Only bills awaiting approval can be approved"), { statusCode: 400 });
    }

    const { data, error } = await this.supabase
      .from("supplier_bills")
      .update({ status: "approved", approval_state: "approved", updated_at: new Date().toISOString() })
      .eq("id", billId)
      .select(StoreService.BILL_SELECT_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  }

  async rejectBill(storeId: string, billId: string, reason?: string | null) {
    const { data: bill, error: fetchError } = await this.supabase
      .from("supplier_bills")
      .select("id, status, notes")
      .eq("id", billId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (fetchError) throw fetchError;
    if (!bill) throw Object.assign(new Error("Bill not found"), { statusCode: 404 });
    if (bill.status !== "pending") {
      throw Object.assign(new Error("Only bills awaiting approval can be rejected"), { statusCode: 400 });
    }

    const notes = reason ? `${bill.notes ? bill.notes + " | " : ""}Rejected: ${reason}` : bill.notes;
    const { data, error } = await this.supabase
      .from("supplier_bills")
      .update({ status: "rejected", approval_state: "rejected", notes, updated_at: new Date().toISOString() })
      .eq("id", billId)
      .select(StoreService.BILL_SELECT_COLUMNS)
      .single();
    if (error) throw error;
    return data;
  }

  // ==========================================================================
  // Bill payment ("Confirm payment") — real Paystack disbursement from the
  // business's Hilaq wallet to the vendor's bank account, gated the same way
  // Bills approvals are (see ApprovalWorkflowService). Distinct from
  // createSupplierPayment, which is the older, purely-manual bookkeeping
  // entry point ("I paid this outside the app, record it") — this path can
  // actually move money.
  // ==========================================================================

  /**
   * Records a payment attempt against an approved bill, debits the wallet
   * immediately (closing the double-spend window a gated approval's delay
   * would otherwise open — see BankingService.debitWalletForBillPayment),
   * then either gates it behind the business's active Transfers/All
   * workflow or, if none exists, executes the transfer immediately.
   */
  async confirmBillPayment(
    storeId: string,
    businessId: string,
    billId: string,
    userId: string,
    userEmail: string | null,
  ): Promise<{ payment: Record<string, unknown>; gated: boolean }> {
    await new BankingService(this.supabase).assertKycVerifiedForTransacting(
      businessId,
      "paying bills from your wallet",
    );

    const bill = await this.getBillById(storeId, billId);
    if (bill.status !== "approved" && bill.status !== "partially_paid") {
      throw Object.assign(new Error("Only approved bills can be paid"), { statusCode: 400 });
    }

    const amountDue = Math.round((Number(bill.amount) - Number((bill as any).paid_amount)) * 100) / 100;
    if (amountDue <= 0) {
      throw Object.assign(new Error("This bill has already been paid in full"), { statusCode: 400 });
    }

    // A bill's own status stays 'approved' the whole time its transfer is
    // in flight (paid_amount only moves once the transfer actually
    // succeeds) — so without this check, confirming payment again while
    // one is still pending/processing would create a second transfer for
    // the same balance, and both could eventually pay out.
    const { data: existingPayment, error: existingPaymentError } = await this.supabase
      .from("supplier_payments")
      .select("id, status")
      .eq("bill_id", billId)
      .in("status", ["pending", "processing"])
      .maybeSingle();
    if (existingPaymentError) throw existingPaymentError;
    if (existingPayment) {
      throw Object.assign(
        new Error("A payment for this bill is already in progress — wait for it to settle or be approved/rejected"),
        { statusCode: 409 },
      );
    }

    const supplier = (bill as any).supplier;
    if (!supplier?.bank_code || !supplier?.account_number || !supplier?.account_name) {
      throw Object.assign(
        new Error("This vendor has no bank account on file — add one before paying"),
        { statusCode: 400 },
      );
    }

    // Same ledger, same RPC the manual "record a payment" flow uses — one
    // payments history regardless of how a payment was made. Inserted
    // 'pending'; the rollup only fires on a later transition to
    // 'successful' via finalize_supplier_payment.
    const { data: paymentRow, error: paymentError } = await this.supabase.rpc("record_supplier_payment", {
      p_store_id: storeId,
      p_supplier_id: bill.supplier_id,
      p_bill_id: billId,
      p_amount: amountDue,
      p_payment_date: new Date().toISOString().split("T")[0],
      p_method: "bank_transfer",
      p_reference: null,
      p_notes: "Wallet transfer to vendor",
      p_created_by: userId,
      p_status: "pending",
    });
    if (paymentError) throw paymentError;
    const payment = Array.isArray(paymentRow) ? paymentRow[0] : paymentRow;

    const banking = new BankingService(this.supabase);
    await banking.debitWalletForBillPayment({
      businessId,
      amount: amountDue,
      providerReference: payment.id,
      description: `Bill payment — ${bill.bill_number}`,
      metadata: { bill_id: billId, payment_id: payment.id, supplier_id: bill.supplier_id },
    });

    let gated = false;
    try {
      const gateResult = await new ApprovalWorkflowService(this.supabase).gateSubmission(businessId, {
        subjectType: "bill_transfer",
        subjectId: payment.id,
        amount: amountDue,
        subjectLabel: `Vendor payment — ${bill.bill_number} — ${supplier.name}`,
        requestedBy: userId,
        requestedByEmail: userEmail,
      });
      gated = gateResult.gated;
    } catch (gateError) {
      // No cross-table transaction here — a blocking gate error (e.g. a
      // step with zero eligible approvers) must undo both the debit and
      // the payment row it was posted for, not leave them behind a failed
      // response the caller believes never took effect.
      await banking
        .reverseWalletDebit({
          businessId,
          providerReference: payment.id,
          amount: amountDue,
          description: `Reversed — payment blocked: ${bill.bill_number}`,
          metadata: { bill_id: billId, payment_id: payment.id },
        })
        .catch(() => {});
      await this.supabase.from("supplier_payments").delete().eq("id", payment.id);
      throw gateError;
    }

    if (!gated) {
      await this.executeBillTransfer(payment.id);
    }

    return { payment: await this.getSupplierPaymentById(payment.id), gated };
  }

  /**
   * The actual disbursement: creates (or reuses) a Paystack transfer
   * recipient for the vendor and initiates the transfer. Idempotent via a
   * conditional claim (status pending -> processing) so two concurrent
   * callers — an ungated confirm and, say, a retried approval decision —
   * can't both fire a transfer for the same payment.
   */
  async executeBillTransfer(paymentId: string): Promise<void> {
    const { data: claimed, error: claimError } = await this.supabase
      .from("supplier_payments")
      .update({ status: "processing" })
      .eq("id", paymentId)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (claimError) throw claimError;
    if (!claimed) return; // already claimed/processed elsewhere

    const { data: payment, error: fetchError } = await this.supabase
      .from("supplier_payments")
      .select("id, store_id, supplier_id, bill_id, amount, notes")
      .eq("id", paymentId)
      .single();
    if (fetchError) throw fetchError;

    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", payment.store_id)
      .single();
    if (storeError) throw storeError;
    const businessId = store.business_id;

    const { data: supplier, error: supplierError } = await this.supabase
      .from("suppliers")
      .select("account_name, account_number, bank_code")
      .eq("id", payment.supplier_id)
      .single();
    if (supplierError) throw supplierError;

    const banking = new BankingService(this.supabase);

    try {
      const balance = await banking.getAvailableBalance(businessId);
      if (balance < Number(payment.amount)) {
        throw Object.assign(new Error("Insufficient wallet balance"), { statusCode: 400 });
      }
      if (!supplier.bank_code || !supplier.account_number || !supplier.account_name) {
        throw Object.assign(new Error("This vendor has no bank account on file"), { statusCode: 400 });
      }

      const recipient = await createPaystackTransferRecipient({
        name: supplier.account_name,
        account_number: supplier.account_number,
        bank_code: supplier.bank_code,
      });
      const reference = createTransactionReference(REFERENCE_TYPES.PAYMENT);

      await this.supabase
        .from("supplier_payments")
        .update({ transfer_recipient_code: recipient.recipient_code, provider_reference: reference })
        .eq("id", paymentId);

      // The one call in this entire codebase path that actually moves real
      // money — everything above only prepares for it.
      const transfer = await initiatePaystackTransfer({
        amount: Number(payment.amount),
        recipient: recipient.recipient_code,
        reference,
        reason: `Hilaq bill payment${payment.notes ? ` — ${payment.notes}` : ""}`,
      });

      let status = this.mapPaystackTransferStatus(transfer.status);
      if (status === "processing") {
        // The bank may settle within seconds — requery once for a fresher
        // status; on failure keep 'processing', the webhook settles it later.
        try {
          const refreshed = await getPaystackTransfer(transfer.transfer_code);
          status = this.mapPaystackTransferStatus(refreshed.status);
        } catch {
          // keep 'processing'
        }
      }

      const { error: finalizeError } = await this.supabase.rpc("finalize_supplier_payment", {
        p_payment_id: paymentId,
        p_status: status,
        p_provider_transfer_code: transfer.transfer_code,
        p_failure_reason: null,
      });
      if (finalizeError) throw finalizeError;

      if (status === "successful") {
        await banking.markBillPaymentDebitPosted(paymentId);
      } else if (status === "failed") {
        await banking.reverseWalletDebit({
          businessId,
          providerReference: paymentId,
          amount: Number(payment.amount),
          description: "Bill payment transfer failed",
          metadata: { payment_id: paymentId },
        });
      }
      // 'processing' — left as-is; the Paystack webhook settles it later.
    } catch (error: any) {
      await this.supabase.rpc("finalize_supplier_payment", {
        p_payment_id: paymentId,
        p_status: "failed",
        p_provider_transfer_code: null,
        p_failure_reason: error?.message ?? "Transfer failed",
      });
      await banking
        .reverseWalletDebit({
          businessId,
          providerReference: paymentId,
          amount: Number(payment.amount),
          description: "Bill payment transfer failed",
          metadata: { payment_id: paymentId, error: error?.message },
        })
        .catch(() => {});
      throw error;
    }
  }

  /** A transfer rejected by an approver never reaches Paystack at all —
   * just settle the payment as failed and give the wallet its money back. */
  async cancelBillTransfer(paymentId: string, reason: string): Promise<void> {
    const { data: payment, error } = await this.supabase
      .from("supplier_payments")
      .select("store_id, amount")
      .eq("id", paymentId)
      .single();
    if (error) throw error;

    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", payment.store_id)
      .single();
    if (storeError) throw storeError;

    const { error: finalizeError } = await this.supabase.rpc("finalize_supplier_payment", {
      p_payment_id: paymentId,
      p_status: "failed",
      p_provider_transfer_code: null,
      p_failure_reason: reason,
    });
    if (finalizeError) throw finalizeError;

    await new BankingService(this.supabase).reverseWalletDebit({
      businessId: store.business_id,
      providerReference: paymentId,
      amount: Number(payment.amount),
      description: `Bill payment rejected: ${reason}`,
      metadata: { payment_id: paymentId },
    });
  }

  private mapPaystackTransferStatus(status: string): "processing" | "successful" | "failed" {
    if (status === "success") return "successful";
    if (status === "failed") return "failed";
    return "processing";
  }

  private async getSupplierPaymentById(paymentId: string) {
    const { data, error } = await this.supabase
      .from("supplier_payments")
      .select(
        "id, store_id, supplier_id, bill_id, amount, payment_date, method, reference, status, transfer_recipient_code, provider_transfer_code, provider_reference, failure_reason, created_at",
      )
      .eq("id", paymentId)
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * Whether the buyer chooses their own price at checkout. Donation products
   * and "pay what you want" products share this path; they differ only in the
   * wording shown to the buyer.
   */
  private buyerSetsPrice(product: {
    type: string;
    allow_custom_price?: boolean | null;
  }): boolean {
    return product.type === "donation" || product.allow_custom_price === true;
  }

  /**
   * Resolve the unit price for a buyer-set-price product, falling back to the
   * suggested/base price when the buyer did not enter a positive amount.
   */
  private resolveBuyerSetPrice(
    product: { price: number; donation?: { suggested_amount?: number } | null },
    requestedPrice: unknown,
  ): number {
    const fallback = product.donation?.suggested_amount ?? product.price;
    return typeof requestedPrice === "number" && requestedPrice > 0
      ? requestedPrice
      : fallback;
  }

  /**
   * For bundle products, resolve the effective price based on pricing_mode.
   * "fixed" uses the stored product price, "sum" totals bundled product prices,
   * "discount" applies a percentage reduction to the sum.
   */
  private async resolveBundlePrice(
    product: {
      type: string;
      bundle?: {
        pricing_mode?: string;
        discount_percentage?: number | null;
        product_ids?: string[];
      } | null;
    },
    storedPrice: number,
  ): Promise<number> {
    if (product.type !== "bundle" || !product.bundle) return storedPrice;

    const { pricing_mode, product_ids, discount_percentage } = product.bundle;

    if (pricing_mode === "fixed" || !pricing_mode) return storedPrice;
    if (!product_ids?.length) return storedPrice;

    const { data: bundledProducts } = await this.supabase
      .from("products")
      .select("price")
      .in("id", product_ids);

    const componentSum = (bundledProducts || []).reduce(
      (total, p) => total + (p.price || 0),
      0,
    );

    if (pricing_mode === "sum") return componentSum;

    if (pricing_mode === "discount" && discount_percentage) {
      return Math.round(componentSum * (1 - discount_percentage / 100));
    }

    return storedPrice;
  }

  private async decrementInventoryForOrderItems(
    items: Array<{
      product_id: string;
      product_name: string;
      quantity: number;
      variant_id?: string | null;
    }>,
    branchId?: string,
    movement?: {
      reference_id?: string | null;
      created_by?: string | null;
    },
  ): Promise<void> {
    const inventoryClient = this.getInventoryClient();

    for (const item of items) {
      // Integrity guard: the declared variant must belong to the declared
      // product (catches malformed client payloads before any write).
      if (item.variant_id) {
        const { data: variant, error: variantError } = await inventoryClient
          .from("product_variants")
          .select("id, product_id")
          .eq("id", item.variant_id)
          .single();

        if (variantError || !variant) {
          throw Object.assign(
            new Error(`Variant not found for ${item.product_name}`),
            { statusCode: 404 },
          );
        }
        if (variant.product_id !== item.product_id) {
          throw Object.assign(
            new Error(`Variant does not belong to ${item.product_name}`),
            { statusCode: 400 },
          );
        }
      }

      // Read the product only for its counter + bundle shape; the single RPC
      // below owns stock validation, the balance decrement, and the ledger.
      const { data: product, error: productError } = await inventoryClient
        .from("products")
        .select("id, orders_count, type, bundle")
        .eq("id", item.product_id)
        .single();

      if (productError || !product) {
        throw Object.assign(
          new Error(`Product not found for ${item.product_name}`),
          { statusCode: 404 },
        );
      }

      // One call for BOTH grains: branch (p_branch_id set) and global
      // (p_branch_id null). Atomic check + row-locked decrement + movement.
      const { error: rpcError } = await inventoryClient.rpc(
        "decrement_product_stock",
        {
          p_product_id: item.product_id,
          p_branch_id: branchId ?? null,
          p_quantity: item.quantity,
          p_variant_id: item.variant_id ?? null,
          p_reason: "sale",
          p_reference_id: movement?.reference_id ?? null,
          p_created_by: movement?.created_by ?? null,
        },
      );
      this.assertStockRpcSucceeded(rpcError, item.product_name);

      await inventoryClient
        .from("products")
        .update({
          orders_count:
            Number(product.orders_count || 0) + Number(item.quantity),
        })
        .eq("id", item.product_id);

      if (product.type === "bundle") {
        await this.decrementBundledProductStock(
          inventoryClient,
          product.bundle,
          item.quantity,
          movement,
        );
      }
    }
  }

  /**
   * Translate a `decrement_product_stock` RPC failure into the app's HTTP
   * contract. PostgREST surfaces a raised exception's SQLSTATE as `code`;
   * P0001 is our insufficient-stock signal, which must stay a 409 (the same
   * status the old JS read-modify-write threw).
   */
  private assertStockRpcSucceeded(error: any, productName: string): void {
    if (!error) return;
    if (error.code === "P0001") {
      throw Object.assign(
        new Error(error.message || `Insufficient stock for ${productName}`),
        { statusCode: 409 as const },
      );
    }
    throw error;
  }

  /**
   * Decrement stock for each product inside a bundle.
   * Best-effort: if a bundled product has null stock (unlimited), skip it.
   * Each tracked component's decrement goes through the SAME unified
   * decrement_product_stock RPC (global grain, branch_id null), which writes
   * its stock_movements row atomically — so bundle components stay in the
   * ledger. A JS pre-check gives the friendly 409 "part of bundle" message;
   * the RPC is the authoritative, race-safe decrement.
   */
  private async decrementBundledProductStock(
    inventoryClient: any,
    bundle: { product_ids?: string[] } | null,
    quantity: number,
    movement?: {
      reference_id?: string | null;
      created_by?: string | null;
    },
  ): Promise<void> {
    const productIds = bundle?.product_ids;
    if (!productIds?.length) return;

    const { data: bundledProducts, error } = await inventoryClient
      .from("products")
      .select("id, name, stock")
      .in("id", productIds);

    if (error) throw error;

    for (const bundledProduct of bundledProducts || []) {
      if (bundledProduct.stock === null) continue;

      if (bundledProduct.stock < quantity) {
        throw Object.assign(
          new Error(
            `Insufficient stock for "${bundledProduct.name}" (part of bundle)`,
          ),
          { statusCode: 409 },
        );
      }

      const { error: rpcError } = await inventoryClient.rpc(
        "decrement_product_stock",
        {
          p_product_id: bundledProduct.id,
          p_branch_id: null,
          p_quantity: quantity,
          p_variant_id: null,
          p_reason: "sale",
          p_reference_id: movement?.reference_id ?? null,
          p_created_by: movement?.created_by ?? null,
        },
      );
      if (rpcError) {
        if (rpcError.code === "P0001") {
          throw Object.assign(
            new Error(
              `Insufficient stock for "${bundledProduct.name}" (part of bundle)`,
            ),
            { statusCode: 409 as const },
          );
        }
        throw rpcError;
      }
    }
  }

  /**
   * Pre-checkout validation: ensure every product inside a bundle has
   * enough stock for the requested quantity. Fails fast before payment.
   */
  private async validateBundledProductStock(
    productIds: string[],
    quantity: number,
  ): Promise<void> {
    const { data: bundledProducts } = await this.supabase
      .from("products")
      .select("id, name, stock")
      .in("id", productIds);

    for (const bundledProduct of bundledProducts || []) {
      if (bundledProduct.stock === null) continue;
      if (bundledProduct.stock < quantity) {
        throw Object.assign(
          new Error(
            `Insufficient stock for "${bundledProduct.name}" (part of bundle)`,
          ),
          { statusCode: 409 },
        );
      }
    }
  }

  /**
   * Generate a unique product slug for the given store.
   * Format: <slugified-name>-<6-char hex suffix>
   * The suffix is derived from the current timestamp + random bytes so it is
   * effectively collision-free without a uniqueness round-trip.
   */
  private generateProductSlug(name: string): string {
    const base = generateSlug(name) || "product";
    const suffix = crypto.randomBytes(3).toString("hex"); // 6 hex chars
    return `${base}-${suffix}`;
  }

  /**
   * Get store by slug
   */
  async getStoreBySlug(slug: string): Promise<Record<string, any>> {
    const { data, error } = await this.supabase
      .from("stores")
      .select("*")
      .eq("slug", slug)
      .single();

    if (error || !data) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }
    return data;
  }

  // ============================================================================
  // Store Management
  // ============================================================================

  /**
   * Initialize a new store for a user or return existing
   */
  async initUserStore(
    userId: string,
    overrides?: Partial<StoreSettings>,
    businessId?: string,
  ): Promise<StoreSettings> {
    // Always creates a new store — callers that want idempotent init must check first
    const defaultStore = createDefaultStoreSettings(
      userId,
      overrides?.name || "My Store",
      overrides?.slug || generateSlug(overrides?.name || "my-store"),
      businessId,
    );

    // Prepare store data, excluding 'business' relation field
    const storeInitData = {
      ...defaultStore,
      ...overrides,
    };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { business: _b, ...storeData } = storeInitData;

    const newStore = {
      ...storeData,
      business_id: businessId, // Ensure business_id is set
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("stores")
      .insert([newStore])
      .select("*")
      .single();

    if (error) throw error;
    return { ...data, orders: [], products: [] } as StoreSettings;
  }

  /**
   * Load store by userId (private) or slug (public)
   */
  async loadStoreByQuery(opts: {
    userId?: string;
    slug?: string;
    requesterId?: string;
    businessId?: string;
  }): Promise<StoreSettings | null> {
    const { userId, slug, requesterId, businessId } = opts;

    if (userId) {
      const { data: prefs } = await this.supabase
        .from("user_preferences")
        .select("last_active_store_id")
        .eq("user_id", userId)
        .single();

      let query = this.supabase.from("stores").select(`
        *,
        business:business_id(
          id,
          name,
          paystack_subaccount_code,
          paystack_fee_bearer
        )
      `);

      if (businessId) {
        query = query.eq("business_id", businessId);
      } else {
        // Legacy fallback: no businessId context, scope by user_id
        query = query.eq("user_id", userId);
      }

      if (prefs?.last_active_store_id) {
        // Prefer the last-used store, but only if it's within the scoped business/user
        const { data: prefStore } = await query
          .eq("id", prefs.last_active_store_id)
          .single();
        if (prefStore) return prefStore as StoreSettings;

        // If preferred store doesn't match scope, fall back to default order
        query = this.supabase.from("stores").select(`
          *,
          business:business_id(
            id,
            name,
            paystack_subaccount_code,
            paystack_fee_bearer
          )
        `);
        if (businessId) query = query.eq("business_id", businessId);
        else query = query.eq("user_id", userId);
      }

      query = query.order("created_at", { ascending: false }).limit(1);

      const { data, error } = await query.single();

      if (error && error.code !== "PGRST116") throw error;
      return data as StoreSettings | null;
    }

    if (slug) {
      // Public access - must be live
      const { data, error } = await this.supabase
        .from("stores")
        .select(
          `
          *,
          business:business_id (
            id,
            name,
            paystack_subaccount_code,
            paystack_fee_bearer
          )
        `,
        )
        .eq("slug", slug)
        .eq("is_live", true)
        .single();

      if (error && error.code !== "PGRST116") throw error;
      return data as StoreSettings | null;
    }

    return null;
  }

  // ============================================================================
  // Multi-Store Support
  // ============================================================================

  /**
   * Get all stores for a specific business with analytics
   */
  async getStoresByBusiness(businessId: string): Promise<
    Array<{
      id: string;
      business_id: string;
      name: string;
      slug: string;
      is_live: boolean;
      appearance: Record<string, any>;
      created_at: string;
      order_count: number;
      total_revenue: number;
    }>
  > {
    // 1. Get stores
    const { data: stores, error: storesError } = await this.supabase
      .from("stores")
      .select("id, business_id, name, slug, is_live, appearance, created_at")
      .eq("business_id", businessId)
      .order("created_at", { ascending: true });

    if (storesError) throw storesError;

    if (!stores || stores.length === 0) return [];

    // 2. Get analytics (orders and revenue) for these stores
    const storeIds = stores.map((s) => s.id);
    const { data: orders, error: ordersError } = await this.supabase
      .from("store_orders")
      .select("store_id, total, status")
      .in("store_id", storeIds)
      .in("status", ["paid", "fulfilled"]);

    if (ordersError) throw ordersError;

    // 3. Map analytics back to stores
    return stores.map((store) => {
      const storeOrders = orders?.filter((o) => o.store_id === store.id) || [];
      const revenue = storeOrders.reduce((sum, o) => sum + Number(o.total), 0);
      return {
        ...store,
        orders: storeOrders.length,
        revenue: revenue,
        order_count: storeOrders.length, // Compatibility
        total_revenue: revenue, // Compatibility
        status: store.is_live ? "Live" : "Draft",
      };
    });
  }

  /**
   * Get store analytics (revenue, orders, customers, products).
   *
   * When `branchId` is given, every figure is scoped to that one branch.
   * When it's omitted and the store has more than one branch, the response
   * also carries a `locations` breakdown (one row per branch, computed
   * in-memory from the same already-fetched orders — matches
   * AnalyticsService.aggregateByDate's grouping style, no new SQL view)
   * so "All locations" callers can render a per-branch table without a
   * second round trip per branch.
   */
  async getStoreAnalytics(
    storeId: string,
    businessId?: string,
    branchId?: string,
  ): Promise<{
    total_revenue: number;
    total_orders: number;
    total_customers: number;
    total_products: number;
    locations?: Array<{
      id: string;
      name: string;
      net_sales: number;
      transactions: number;
      average_sale: number;
    }>;
  }> {
    // Validate store ownership if businessId provided
    if (businessId) {
      const { data: store, error: storeError } = await this.supabase
        .from("stores")
        .select("id")
        .eq("id", storeId)
        .eq("business_id", businessId)
        .single();

      if (storeError || !store) {
        throw Object.assign(new Error("Store not found or access denied"), {
          statusCode: 404,
        });
      }
    }

    // Get orders with status 'paid' or 'fulfilled'
    let ordersQuery = this.supabase
      .from("store_orders")
      .select("id, total, status, customer_email, branch_id")
      .eq("store_id", storeId)
      .in("status", ["paid", "fulfilled"]);

    if (branchId) {
      ordersQuery = ordersQuery.eq("branch_id", branchId);
    }

    const { data: orders, error: ordersError } = await ordersQuery;

    if (ordersError) throw ordersError;

    // Calculate totals
    const total_revenue = (orders || []).reduce(
      (sum, o) => sum + Number(o.total || 0),
      0,
    );
    const total_orders = (orders || []).length;

    // Count unique customers by email
    const uniqueEmails = new Set(
      (orders || [])
        .map((o) => o.customer_email?.toLowerCase())
        .filter(Boolean),
    );
    const total_customers = uniqueEmails.size;

    // Count all products in store
    const { count: productCount, error: productError } = await this.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("is_sellable", true);

    if (productError) throw productError;

    let locations:
      | Array<{
          id: string;
          name: string;
          net_sales: number;
          transactions: number;
          average_sale: number;
        }>
      | undefined;

    if (!branchId) {
      const { data: branches, error: branchesError } = await this.supabase
        .from("store_branches")
        .select("id, name")
        .eq("store_id", storeId);

      if (branchesError) throw branchesError;

      if (branches && branches.length > 1) {
        const salesByBranch = new Map(
          branches.map((b) => [
            b.id as string,
            { name: b.name as string, net_sales: 0, transactions: 0 },
          ]),
        );
        const unassigned = { net_sales: 0, transactions: 0 };
        let hasUnassigned = false;

        for (const order of orders || []) {
          const total = Number(order.total || 0);
          const entry = order.branch_id
            ? salesByBranch.get(order.branch_id)
            : undefined;
          if (entry) {
            entry.net_sales += total;
            entry.transactions += 1;
          } else {
            hasUnassigned = true;
            unassigned.net_sales += total;
            unassigned.transactions += 1;
          }
        }

        locations = Array.from(salesByBranch.entries()).map(([id, v]) => ({
          id,
          name: v.name,
          net_sales: v.net_sales,
          transactions: v.transactions,
          average_sale: v.transactions > 0 ? v.net_sales / v.transactions : 0,
        }));

        if (hasUnassigned) {
          locations.push({
            id: "unassigned",
            name: "Unassigned",
            net_sales: unassigned.net_sales,
            transactions: unassigned.transactions,
            average_sale:
              unassigned.transactions > 0
                ? unassigned.net_sales / unassigned.transactions
                : 0,
          });
        }
      }
    }

    return {
      total_revenue,
      total_orders,
      total_customers,
      total_products: productCount || 0,
      ...(locations ? { locations } : {}),
    };
  }

  /**
   * Get a specific store by ID with business context validation
   */
  async getStoreById(
    storeId: string,
    businessId?: string,
  ): Promise<StoreSettings> {
    let query = this.supabase
      .from("stores")
      .select(
        `
      *,
      business:business_id (
        id,
        name,
        paystack_subaccount_code,
        paystack_fee_bearer
      )
    `,
      )
      .eq("id", storeId);

    if (businessId) {
      query = query.eq("business_id", businessId);
    }

    const { data, error } = await query.single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Store not found"), { statusCode: 404 });
      }
      throw error;
    }

    return data as StoreSettings;
  }

  /**
   * Validate that a user owns a store (reusable helper)
   * Now scopes by businessId for multi-tenancy.
   */
  async validateStoreOwnership(
    storeId: string,
    userId: string,
    businessId?: string,
  ): Promise<StoreSettings> {
    return this.getStoreById(storeId, businessId);
  }

  /**
   * Create a new store for a business
   */
  async createStore(
    userId: string,
    businessId: string,
    payload: {
      name: string;
      slug?: string;
      sells_in_person?: boolean;
    },
  ): Promise<StoreSettings> {
    const slug = payload.slug || generateSlug(payload.name);

    // Check if slug is already taken
    const { data: existingSlug } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .single();

    if (existingSlug) {
      throw Object.assign(new Error("Store slug already exists"), {
        statusCode: 409,
      });
    }

    const defaultStore = createDefaultStoreSettings(
      userId,
      payload.name,
      slug,
      businessId,
    );

    // Prepare store data, excluding 'business' relation field
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { business: _b, ...storeData } = defaultStore;

    const newStore = {
      ...storeData,
      business_id: businessId,
      sells_in_person: payload.sells_in_person ?? false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("stores")
      .insert([newStore])
      .select("*")
      .single();

    if (error) throw error;
    return { ...data, orders: [], products: [] } as StoreSettings;
  }

  /**
   * Save/update user's store
   */
  async saveUserStore(
    userId: string,
    storeId: string,
    payload: Partial<StoreSettings>,
    businessId?: string,
  ): Promise<StoreSettings> {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    const { data: existing, error: existingError } = await this.supabase
      .from("stores")
      .select("*")
      .eq("id", storeId)
      .single();

    if (existingError) throw existingError;
    if (!existing) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    if (payload.appearance) {
      if (payload.appearance.cover_image) {
        payload.appearance.cover_image = await processStoreAppearanceImage(
          this.supabase,
          payload.appearance.cover_image,
          storeId,
          "banner",
        );
      }
      if (payload.appearance.logo) {
        payload.appearance.logo = await processStoreAppearanceImage(
          this.supabase,
          payload.appearance.logo,
          storeId,
          "logo",
        );
      }
    }

    // Keep the store's selling currencies to supported codes, with NGN as base.
    if (payload.supported_currencies !== undefined) {
      payload.supported_currencies = normalizeSupportedCurrencies(
        payload.supported_currencies,
      );
    }

    // Deep merge nested objects to preserve existing fields
    const mergedAppearance = payload.appearance
      ? { ...(existing.appearance || {}), ...payload.appearance }
      : existing.appearance;

    const mergedDelivery = payload.delivery
      ? { ...(existing.delivery || {}), ...payload.delivery }
      : existing.delivery;

    const mergedAfterPurchase = payload.after_purchase
      ? { ...(existing.after_purchase || {}), ...payload.after_purchase }
      : existing.after_purchase;

    const updated = {
      ...existing,
      ...payload,
      // Override with deep-merged nested objects
      appearance: mergedAppearance,
      delivery: mergedDelivery,
      after_purchase: mergedAfterPurchase,
      user_id: userId, // Ensure user_id doesn't change
      id: existing.id, // Ensure id doesn't change
      updated_at: new Date().toISOString(),
    };

    // Strip non-database fields that might be in the payload/merged object
    const { business, store_id, ...finalUpdate } = updated;

    const { data, error } = await this.supabase
      .from("stores")
      .update(finalUpdate)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) throw error;
    return data as StoreSettings;
  }

  // ===========================================================================
  // Store Subaccount Override (for franchises)
  // ===========================================================================

  /**
   * Get store subaccount override settings
   */
  async getStoreSubaccount(storeId: string): Promise<{
    paystack_subaccount_code: string | null;
    paystack_fee_bearer: FeeBearer | null;
    business_name: string | null;
    settlement_bank: string | null;
    account_number: string | null;
  }> {
    const { data, error } = await this.supabase
      .from("stores")
      .select(
        "paystack_subaccount_code, business:business_id(paystack_fee_bearer)",
      )
      .eq("id", storeId)
      .single();

    if (error) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const business = Array.isArray(data.business)
      ? data.business[0]
      : data.business;

    let details = {
      business_name: null,
      settlement_bank: null,
      account_number: null,
    };

    if (data.paystack_subaccount_code) {
      try {
        const { fetchPaystackSubaccount } =
          await import("../utils/paystack.util");
        const subaccount = await fetchPaystackSubaccount(
          data.paystack_subaccount_code,
        );
        details = {
          business_name: subaccount.business_name,
          settlement_bank: subaccount.settlement_bank,
          account_number: subaccount.account_number,
        };
      } catch (err) {
        console.error("Failed to fetch subaccount details", err);
      }
    }

    return {
      paystack_subaccount_code: data.paystack_subaccount_code || null,
      paystack_fee_bearer: business?.paystack_fee_bearer || null,
      ...details,
    };
  }

  /**
   * Update store subaccount override settings (for franchises)
   */
  async updateStoreSubaccount(
    storeId: string,
    userId: string,
    settings: {
      paystack_subaccount_code?: string | null;
    },
    businessId?: string,
  ): Promise<void> {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    const updateData: any = {};

    if (settings.paystack_subaccount_code !== undefined) {
      updateData.paystack_subaccount_code = settings.paystack_subaccount_code;
    }

    const { error } = await this.supabase
      .from("stores")
      .update(updateData)
      .eq("id", storeId);

    if (error) throw error;
  }

  /**
   * Toggle store live status
   */
  async setStorePublication(
    userId: string,
    storeId: string,
    body: { is_live: boolean; slug?: string },
    businessId?: string,
  ): Promise<StoreSettings> {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    const { data: existing, error } = await this.supabase
      .from("stores")
      .select("*")
      .eq("id", storeId)
      .single();

    if (error) throw error;

    // Check if slug is unique (if changing)
    if (body.slug && body.slug !== existing.slug) {
      const { data: slugCheck } = await this.supabase
        .from("stores")
        .select("id")
        .eq("slug", body.slug)
        .single();

      if (slugCheck && slugCheck.id !== existing.id) {
        throw Object.assign(new Error("Slug already in use"), {
          statusCode: 409,
        });
      }
    }

    // If publishing, check if there are published products
    if (body.is_live) {
      const { data: products } = await this.supabase
        .from("products")
        .select("id")
        .eq("store_id", existing.id)
        .eq("status", "published")
        .eq("is_sellable", true)
        .limit(1);

      if (!products || products.length === 0) {
        throw Object.assign(
          new Error("Cannot publish store without published products"),
          { statusCode: 400 },
        );
      }
    }

    const updated = {
      ...existing,
      is_live: body.is_live,
      slug: body.slug || existing.slug,
      updated_at: new Date().toISOString(),
    };

    const { data: saved, error: saveError } = await this.supabase
      .from("stores")
      .update(updated)
      .eq("id", existing.id)
      .select("*")
      .single();

    if (saveError) throw saveError;
    return saved as StoreSettings;
  }

  // ============================================================================
  // Product Management
  // ============================================================================

  /**
   * Load the currencies a store sells in. NGN is always included as the base.
   */
  private async getStoreSupportedCurrencies(
    storeId: string,
  ): Promise<string[]> {
    const { data } = await this.supabase
      .from("stores")
      .select("supported_currencies")
      .eq("id", storeId)
      .single();

    const configured = (data?.supported_currencies as string[]) || [];
    return configured.includes("NGN") ? configured : ["NGN", ...configured];
  }

  /**
   * Reject per-currency prices that target a currency the store does not sell in
   * or that are otherwise invalid. No-op when the product sets no overrides.
   */
  private async assertValidCurrencyPrices(
    storeId: string,
    currencyPrices: CurrencyPriceMap | null | undefined,
  ): Promise<void> {
    if (!currencyPrices || Object.keys(currencyPrices).length === 0) return;

    const storeCurrencies = await this.getStoreSupportedCurrencies(storeId);
    const errorMessage = validateCurrencyPrices(
      currencyPrices,
      storeCurrencies,
    );
    if (errorMessage) {
      throw Object.assign(new Error(errorMessage), { statusCode: 400 });
    }
  }

  private async syncProductSuppliers(
    storeId: string,
    productId: string,
    supplierIds: string[],
    unitCost?: number | null,
  ): Promise<void> {
    const uniqueSupplierIds = [...new Set(supplierIds)];
    if (uniqueSupplierIds.length > 0) {
      const { data: suppliers, error } = await this.supabase
        .from("suppliers")
        .select("id")
        .eq("store_id", storeId)
        .in("id", uniqueSupplierIds);
      if (error) throw error;
      if ((suppliers ?? []).length !== uniqueSupplierIds.length) {
        throw Object.assign(new Error("One or more suppliers do not belong to this store"), { statusCode: 400 });
      }
    }

    const { data: existing, error: existingError } = await this.supabase
      .from("supplier_products")
      .select("supplier_id, is_preferred")
      .eq("store_id", storeId)
      .eq("product_id", productId)
      .is("variant_id", null);
    if (existingError) throw existingError;

    const retainedSupplierIds = new Set(uniqueSupplierIds);
    const removedSupplierIds = (existing ?? [])
      .map((row) => row.supplier_id)
      .filter((supplierId) => !retainedSupplierIds.has(supplierId));
    if (removedSupplierIds.length > 0) {
      const { error } = await this.supabase
        .from("supplier_products")
        .delete()
        .eq("store_id", storeId)
        .eq("product_id", productId)
        .is("variant_id", null)
        .in("supplier_id", removedSupplierIds);
      if (error) throw error;
    }

    const existingSupplierIds = new Set((existing ?? []).map((row) => row.supplier_id));
    const hasPreferredSupplier = (existing ?? []).some(
      (row) => row.is_preferred && retainedSupplierIds.has(row.supplier_id),
    );
    const newMappings = uniqueSupplierIds
      .filter((supplierId) => !existingSupplierIds.has(supplierId))
      .map((supplierId, index) => ({
        store_id: storeId,
        product_id: productId,
        supplier_id: supplierId,
        variant_id: null,
        unit_cost: unitCost ?? null,
        is_preferred: !hasPreferredSupplier && index === 0,
      }));
    if (newMappings.length > 0) {
      const { error } = await this.supabase.from("supplier_products").insert(newMappings);
      if (error) throw error;
    }
  }

  private async getSupplierIdsByProduct(
    storeId: string,
    productIds: string[],
  ): Promise<Record<string, string[]>> {
    if (productIds.length === 0) return {};
    const { data, error } = await this.supabase
      .from("supplier_products")
      .select("product_id, supplier_id")
      .eq("store_id", storeId)
      .eq("status", "active")
      .is("variant_id", null)
      .in("product_id", productIds);
    if (error) throw error;
    return (data ?? []).reduce<Record<string, string[]>>((result, row) => {
      result[row.product_id] = [...(result[row.product_id] ?? []), row.supplier_id];
      return result;
    }, {});
  }

  /**
   * Add a product to a store
   */
  async addProduct(
    storeId: string,
    product: Omit<Product, "id" | "created_at" | "updated_at"> & {
      category_ids?: string[];
    },
    userId: string,
    businessId?: string,
  ): Promise<
    Product & { categories: Array<{ id: string; name: string; slug: string }> }
  > {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    // Extract category_ids, marketplace_category_id and variants before inserting product
    const {
      category_ids,
      marketplace_category_id,
      variants,
      module_link,
      supplier_ids,
      ...productData
    } = product;

    // Validate bundle product_ids if this is a bundle
    if (
      productData.type === "bundle" &&
      productData.bundle?.product_ids?.length
    ) {
      const bundleProductIds = productData.bundle.product_ids;
      const { data: bundleProducts, error: bundleError } = await this.supabase
        .from("products")
        .select("id")
        .eq("store_id", storeId)
        .in("id", bundleProductIds);

      if (bundleError) throw bundleError;

      const foundIds = new Set(bundleProducts?.map((p) => p.id) || []);
      const missingIds = bundleProductIds.filter((id) => !foundIds.has(id));

      if (missingIds.length > 0) {
        throw Object.assign(
          new Error(
            `Bundle contains invalid product IDs: ${missingIds.join(", ")}`,
          ),
          { statusCode: 400 },
        );
      }
    }

    await this.assertValidCurrencyPrices(storeId, productData.currency_prices);

    if (!productData.is_sellable) {
      productData.storefront_enabled = false;
      productData.pos_enabled = false;
      productData.marketplace_enabled = false;
      productData.status = "draft";
    }

    const hasEnabledChannel =
      productData.storefront_enabled ||
      productData.pos_enabled ||
      productData.marketplace_enabled;
    if (productData.status === "published" && !hasEnabledChannel) {
      throw Object.assign(
        new Error("Published products must be enabled in at least one sales channel"),
        { statusCode: 400 },
      );
    }

    const productUnit = await this.resolveProductUnit(
      productData.unit_of_sale ?? "piece",
    );

    const newProduct = {
      ...productData,
      unit_id: productUnit.id,
      unit_of_sale: productUnit.code,
      store_id: storeId,
      created_by: userId,
      slug: this.generateProductSlug(productData.name),
      marketplace_category_id: marketplace_category_id || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await this.supabase
      .from("products")
      .insert([newProduct])
      .select("*")
      .single();

    if (error) throw error;

    // Process images (upload base64 if needed)
    const processedCoverImage = await processProductImage(
      this.supabase,
      productData.cover_image,
      storeId,
      data.id,
    );

    const processedImages = productData.images?.length
      ? await processProductImages(
          this.supabase,
          productData.images,
          storeId,
          data.id,
        )
      : [];

    // update the product with the processed images
    const { error: updateError } = await this.supabase
      .from("products")
      .update({
        cover_image: processedCoverImage,
        images: processedImages,
      })
      .eq("id", data.id);

    if (updateError) throw updateError;

    // Assign categories if provided
    if (category_ids && category_ids.length > 0) {
      await this.assignProductCategories(storeId, data.id, category_ids);
    }

    // Fetch and return categories
    const categories = await this.getProductCategories(data.id);

    // Sync variants if provided
    if (variants && Array.isArray(variants)) {
      await this.syncProductVariants(data.id, variants);
    }

    await this.syncProductSuppliers(
      storeId,
      data.id,
      supplier_ids ?? [],
      productData.cost,
    );

    // Sync module link (unified) if provided
    if (module_link && module_link.module_type && module_link.entity_id) {
      const store = await this.getStoreById(storeId, businessId);
      await this.syncProductModuleLink(
        data.id,
        module_link.module_type as ModuleLinkTypeValue,
        module_link.entity_id,
        (module_link.config ?? {}) as Record<string, unknown>,
        store.business_id!,
      );
    }

    // Fetch final product state with links
    const finalProduct = await this.getStoreProduct(
      storeId,
      data.id,
      businessId,
    );
    return { ...finalProduct, categories };
  }

  /**
   * Update a product
   */
  async updateProduct(
    storeId: string,
    productId: string,
    updates: Partial<Product> & { category_ids?: string[] },
    userId: string,
    businessId?: string,
  ): Promise<
    Product & { categories: Array<{ id: string; name: string; slug: string }> }
  > {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    const {
      category_ids,
      marketplace_category_id,
      variants,
      module_link,
      supplier_ids,
      ...productUpdates
    } = updates;

    delete productUpdates.unit_id;

    const { data: existing, error: existingError } = await this.supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (existingError) throw existingError;
    if (!existing) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    if (productUpdates.currency_prices !== undefined) {
      await this.assertValidCurrencyPrices(
        storeId,
        productUpdates.currency_prices,
      );
    }

    // Build the partial update object
    const finalUpdates: any = {
      ...productUpdates,
      updated_at: new Date().toISOString(),
    };

    if (productUpdates.unit_of_sale !== undefined) {
      const productUnit = await this.resolveProductUnit(
        productUpdates.unit_of_sale,
      );
      finalUpdates.unit_id = productUnit.id;
      finalUpdates.unit_of_sale = productUnit.code;
    }

    if (productUpdates.is_sellable === false) {
      productUpdates.storefront_enabled = false;
      productUpdates.pos_enabled = false;
      productUpdates.marketplace_enabled = false;
      productUpdates.status = "draft";
    }

    const nextStatus = productUpdates.status ?? existing.status;
    const hasEnabledChannel =
      (productUpdates.storefront_enabled ?? existing.storefront_enabled ?? true) ||
      (productUpdates.pos_enabled ?? existing.pos_enabled ?? true) ||
      (productUpdates.marketplace_enabled ?? existing.marketplace_enabled ?? true);
    if (nextStatus === "published" && !hasEnabledChannel) {
      throw Object.assign(
        new Error("Published products must be enabled in at least one sales channel"),
        { statusCode: 400 },
      );
    }

    if (marketplace_category_id !== undefined) {
      finalUpdates.marketplace_category_id = marketplace_category_id;
    }

    // Handle nested objects merge to prevent wiping out data
    const nestedFields = [
      "digital",
      "physical",
      "service",
      "membership",
      "bundle",
    ];
    console.log("Publish Product debug", productUpdates, existing);

    for (const field of nestedFields) {
      if (
        (productUpdates as any)[field] &&
        typeof (productUpdates as any)[field] === "object"
      ) {
        finalUpdates[field] = {
          ...(existing as any)[field],
          ...(productUpdates as any)[field],
        };
      }
    }

    // Process images if they are base64
    if (finalUpdates.cover_image !== undefined) {
      finalUpdates.cover_image = await processProductImage(
        this.supabase,
        finalUpdates.cover_image,
        storeId,
        productId,
      );
    }

    if (finalUpdates.images !== undefined) {
      finalUpdates.images = await processProductImages(
        this.supabase,
        finalUpdates.images || [],
        storeId,
        productId,
      );
    }

    // Perform partial update on specified fields only
    const { data, error } = await this.supabase
      .from("products")
      .update(finalUpdates)
      .eq("id", productId)
      .select("*")
      .single();

    if (error) throw error;

    // Update categories if provided
    if (category_ids !== undefined) {
      await this.assignProductCategories(storeId, productId, category_ids);
    }

    // Sync variants if provided
    if (variants && Array.isArray(variants)) {
      await this.syncProductVariants(productId, variants);
    }

    if (supplier_ids !== undefined) {
      await this.syncProductSuppliers(
        storeId,
        productId,
        supplier_ids,
        productUpdates.cost ?? existing.cost,
      );
    }

    // Sync module link (unified) if provided
    if (module_link !== undefined) {
      if (module_link === null) {
        await this.deleteProductModuleLink(productId);
      } else if (module_link.module_type && module_link.entity_id) {
        const store = await this.getStoreById(storeId, businessId);
        await this.syncProductModuleLink(
          productId,
          module_link.module_type as ModuleLinkTypeValue,
          module_link.entity_id,
          (module_link.config ?? {}) as Record<string, unknown>,
          store.business_id!,
        );
      }
    }

    // Fetch and return categories
    const categories = await this.getProductCategories(productId);

    // Fetch complete updated product with links
    const updatedProduct = await this.getStoreProduct(
      storeId,
      productId,
      businessId,
    );

    return { ...updatedProduct, categories };
  }

  /**
   * Delete a product
   */
  async deleteProduct(
    storeId: string,
    productId: string,
    userId: string,
    businessId?: string,
  ): Promise<void> {
    await this.validateStoreOwnership(storeId, userId, businessId);

    // Fetch file URLs before deleting the row so we can clean up storage
    const { data: product } = await this.supabase
      .from("products")
      .select("cover_image, images, digital, type")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    const { error } = await this.supabase
      .from("products")
      .delete()
      .eq("id", productId)
      .eq("store_id", storeId);

    if (error) throw error;

    await this.deleteProductModuleLink(productId);

    // Best-effort file cleanup — don't fail the delete if storage removal errors
    if (product) {
      this.cleanupProductFiles(product).catch((err) =>
        console.error(
          `[StoreService.deleteProduct] File cleanup error for ${productId}:`,
          err,
        ),
      );
    }
  }

  /**
   * Deletes all storage files associated with a digital product.
   * with a product. Called fire-and-forget after the DB row is removed.
   */
  private async cleanupProductFiles(product: {
    cover_image?: string | null;
    images?: string[] | null;
    digital?: {
      download_url?: string | null;
      files?: {
        pdf_url?: string | null;
        epub_url?: string | null;
        mobi_url?: string | null;
      } | null;
      sample_url?: string | null;
    } | null;
    type?: string;
  }): Promise<void> {
    const urls: string[] = [];

    if (product.cover_image) urls.push(product.cover_image);
    if (product.images) urls.push(...product.images.filter(Boolean));

    if (product.digital?.download_url) {
      urls.push(product.digital.download_url);
    }

    if (product.digital?.files) {
      const { pdf_url, epub_url, mobi_url } = product.digital.files;
      if (pdf_url) urls.push(pdf_url);
      if (epub_url) urls.push(epub_url);
      if (mobi_url) urls.push(mobi_url);
    }
    if (product.digital?.sample_url) urls.push(product.digital.sample_url);

    await Promise.all(
      urls.map((url) => deleteStorageImage(this.supabase, url).catch(() => {})),
    );
  }

  /**
   * Per-branch price/availability overrides for a product (Branch-Aware
   * Storefront). See applyBranchOverrides for how these are consumed at
   * read/checkout time.
   */
  async getProductBranchOverrides(
    storeId: string,
    productId: string,
  ): Promise<ProductBranchOverride[]> {
    // Was a `product:products!inner(store_id)` embed to scope both queries
    // to this store in one round trip — avoided in favor of a plain
    // ownership check + plain per-table selects, since PostgREST
    // relationship embeds have been an unreliable source of 500s on this
    // project (see the register_shifts.opened_by note elsewhere). Same
    // pattern upsertProductBranchOverrides already uses below.
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();
    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    const { data: catalogOverrides, error: catalogError } = await this.supabase
      .from("branch_catalog_overrides")
      .select(
        "id, product_id, branch_id, is_available, price, currency_prices, lead_time_hours, created_at, updated_at",
      )
      .eq("product_id", productId);

    if (catalogError) throw catalogError;

    const { data: inventoryOverrides, error: inventoryError } =
      await this.supabase
        .from("branch_inventory_overrides")
        .select(
          "id, product_id, branch_id, variant_id, stock_quantity, reserved_quantity, created_at, updated_at",
        )
        .eq("product_id", productId);

    if (inventoryError) throw inventoryError;

    const byBranch = new Map<string, ProductBranchOverride>();
    for (const rawCatalog of catalogOverrides || []) {
      byBranch.set(rawCatalog.branch_id, {
        id: rawCatalog.id,
        product_id: rawCatalog.product_id,
        branch_id: rawCatalog.branch_id,
        is_available: rawCatalog.is_available,
        price: rawCatalog.price,
        currency_prices: rawCatalog.currency_prices,
        lead_time_hours: rawCatalog.lead_time_hours,
        variant_stock: {},
        created_at: rawCatalog.created_at,
        updated_at: rawCatalog.updated_at,
      });
    }

    for (const rawInventory of inventoryOverrides || []) {
      let override = byBranch.get(rawInventory.branch_id);
      if (!override) {
        override = {
          id: rawInventory.id,
          product_id: rawInventory.product_id,
          branch_id: rawInventory.branch_id,
          is_available: true,
          price: null,
          currency_prices: null,
          lead_time_hours: null,
          variant_stock: {},
          created_at: rawInventory.created_at,
          updated_at: rawInventory.updated_at,
        };
        byBranch.set(rawInventory.branch_id, override);
      }

      if (rawInventory.variant_id === null) {
        override.stock_quantity = rawInventory.stock_quantity;
        override.reserved_quantity = rawInventory.reserved_quantity;
      } else {
        override.variant_stock[rawInventory.variant_id] =
          rawInventory.stock_quantity;
      }
    }

    return Array.from(byBranch.values());
  }

  /**
   * Replace all branch overrides for a product with the given branch-level
   * DTOs. Catalog exceptions are stored in branch_catalog_overrides; sparse
   * product/variant balances are stored as normalized rows in
   * branch_inventory_overrides. Branches omitted here revert to inheritance.
   */
  async upsertProductBranchOverrides(
    storeId: string,
    productId: string,
    overrides: Array<{
      branch_id: string;
      is_available?: boolean;
      price?: number | null;
      currency_prices?: Record<
        string,
        { price: number; compare_at_price?: number | null }
      > | null;
      lead_time_hours?: number | null;
      stock_quantity?: number | null;
      reserved_quantity?: number;
      variant_stock?: Record<string, number | null>;
    }>,
  ): Promise<ProductBranchOverride[]> {
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();
    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    const branchIds = [...new Set(overrides.map((override) => override.branch_id))];
    if (branchIds.length !== overrides.length) {
      throw Object.assign(new Error("A branch override may only appear once"), {
        statusCode: 400,
      });
    }

    for (const override of overrides) {
      if (
        override.stock_quantity != null &&
        (override.reserved_quantity ?? 0) > override.stock_quantity
      ) {
        throw Object.assign(
          new Error("Reserved branch stock cannot exceed stock quantity"),
          { statusCode: 400 },
        );
      }
    }

    if (branchIds.length > 0) {
      const { data: branches, error: branchesError } = await this.supabase
        .from("store_branches")
        .select("id")
        .eq("store_id", storeId)
        .in("id", branchIds);
      if (branchesError) throw branchesError;
      if ((branches || []).length !== branchIds.length) {
        throw Object.assign(
          new Error("One or more branches do not belong to this store"),
          { statusCode: 400 },
        );
      }
    }

    const variantIds = [
      ...new Set(
        overrides.flatMap((override) => Object.keys(override.variant_stock || {})),
      ),
    ];
    if (variantIds.length > 0) {
      const { data: variants, error: variantsError } = await this.supabase
        .from("product_variants")
        .select("id")
        .eq("product_id", productId)
        .in("id", variantIds);
      if (variantsError) throw variantsError;
      if ((variants || []).length !== variantIds.length) {
        throw Object.assign(
          new Error("One or more variants do not belong to this product"),
          { statusCode: 400 },
        );
      }
    }

    const { error: deleteCatalogError } = await this.supabase
      .from("branch_catalog_overrides")
      .delete()
      .eq("product_id", productId);
    if (deleteCatalogError) throw deleteCatalogError;

    const { error: deleteInventoryError } = await this.supabase
      .from("branch_inventory_overrides")
      .delete()
      .eq("product_id", productId);
    if (deleteInventoryError) throw deleteInventoryError;

    if (overrides.length === 0) return [];

    const catalogRows = overrides
      .filter(
        (override) =>
          override.is_available === false ||
          override.price != null ||
          override.currency_prices != null ||
          override.lead_time_hours != null,
      )
      .map((override) => ({
        product_id: productId,
        branch_id: override.branch_id,
        is_available: override.is_available ?? true,
        price: override.price ?? null,
        currency_prices: override.currency_prices ?? null,
        lead_time_hours: override.lead_time_hours ?? null,
      }));

    if (catalogRows.length > 0) {
      const { error: catalogInsertError } = await this.supabase
        .from("branch_catalog_overrides")
        .insert(catalogRows);
      if (catalogInsertError) throw catalogInsertError;
    }

    const inventoryRows = overrides.flatMap((override) => {
      const rows: Array<{
        product_id: string;
        branch_id: string;
        variant_id: string | null;
        stock_quantity: number | null;
        reserved_quantity: number;
      }> = [];

      const hasProductStock = Object.prototype.hasOwnProperty.call(
        override,
        "stock_quantity",
      );
      if (hasProductStock || override.reserved_quantity !== undefined) {
        rows.push({
          product_id: productId,
          branch_id: override.branch_id,
          variant_id: null,
          stock_quantity: override.stock_quantity ?? null,
          reserved_quantity: override.reserved_quantity ?? 0,
        });
      }

      for (const [variantId, stockQuantity] of Object.entries(
        override.variant_stock || {},
      )) {
        rows.push({
          product_id: productId,
          branch_id: override.branch_id,
          variant_id: variantId,
          stock_quantity: stockQuantity,
          reserved_quantity: 0,
        });
      }
      return rows;
    });

    if (inventoryRows.length > 0) {
      const { error: inventoryInsertError } = await this.supabase
        .from("branch_inventory_overrides")
        .insert(inventoryRows);
      if (inventoryInsertError) throw inventoryInsertError;
    }

    return this.getProductBranchOverrides(storeId, productId);
  }

  /**
   * Upload product image
   */
  async uploadProductImage(
    storeId: string,
    productId: string,
    assetType: "cover" | "gallery",
    file: Express.Multer.File,
  ) {
    const fileExt = file.originalname.split(".").pop();
    const fileName = `${assetType}_${Date.now()}.${fileExt}`;
    const filePath = `${storeId}/products/${productId}/${assetType}/${fileName}`;
    return this.storageService.uploadFile("stores", filePath, file, true);
  }

  // ============================================================================
  // Product Module Linkage (unified — publications, forms, event_types, courses)
  // ============================================================================

  /**
   * Fetch the module link for a single product (from the unified table).
   */
  async getProductModuleLink(
    productId: string,
    includeMeta = false,
  ): Promise<{
    module_type: ModuleLinkTypeValue;
    entity_id: string;
    config: Record<string, unknown>;
    _entity_meta?: EntityMeta;
  } | null> {
    const { data, error } = await this.supabase
      .from("product_module_links")
      .select("*")
      .eq("product_id", productId)
      .maybeSingle();

    if (error) throw error;

    let result: {
      module_type: ModuleLinkTypeValue;
      entity_id: string;
      config: Record<string, unknown>;
      _entity_meta?: EntityMeta;
    } | null = null;

    if (data) {
      result = {
        module_type: data.module_type as ModuleLinkTypeValue,
        entity_id: data.entity_id,
        config: (data.config ?? {}) as Record<string, unknown>,
      };
    }

    // Enrich with entity metadata (slug, name, image, url) when requested.
    // This is used by the single-product endpoint so the frontend can build
    // correct slug-based redirect URLs instead of falling back to entity_id.
    if (result && includeMeta) {
      try {
        const meta = await moduleRegistryService.fetchMeta(
          this.supabase,
          result.module_type,
          result.entity_id,
        );
        if (meta) result._entity_meta = meta;
      } catch (metaErr) {
        // Non-fatal — frontend falls back to entity_id
        console.warn(
          "getProductModuleLink: failed to fetch entity meta",
          metaErr,
        );
      }
    }

    return result;
  }

  /**
   * Sync (upsert) a module link. Validates entity ownership via the registry.
   */
  async syncProductModuleLink(
    productId: string,
    moduleType: ModuleLinkTypeValue,
    entityId: string,
    config: Record<string, unknown>,
    businessId: string,
  ): Promise<void> {
    // 1. Validate entity belongs to the same business
    const valid = await moduleRegistryService.validate(
      this.supabase,
      moduleType,
      entityId,
      businessId,
    );
    if (!valid) {
      throw Object.assign(
        new Error(
          `${moduleType} entity not found or does not belong to this business`,
        ),
        { statusCode: 404 },
      );
    }

    // 2. Upsert into unified table
    const { error } = await this.supabase.from("product_module_links").upsert({
      product_id: productId,
      module_type: moduleType,
      entity_id: entityId,
      config,
      updated_at: new Date().toISOString(),
    });

    if (error) throw error;
  }

  /**
   * Delete a product's module link.
   */
  async deleteProductModuleLink(productId: string): Promise<void> {
    const { error } = await this.supabase
      .from("product_module_links")
      .delete()
      .eq("product_id", productId);

    if (error) throw error;
  }

  /**
   * Batch-fetch module links for a list of product IDs.
   */
  async batchFetchModuleLinks(productIds: string[]): Promise<
    Record<
      string,
      {
        module_type: ModuleLinkTypeValue;
        entity_id: string;
        config: Record<string, unknown>;
      }
    >
  > {
    if (productIds.length === 0) return {};

    const { data: links } = await this.supabase
      .from("product_module_links")
      .select("*")
      .in("product_id", productIds);

    const result: Record<
      string,
      {
        module_type: ModuleLinkTypeValue;
        entity_id: string;
        config: Record<string, unknown>;
      }
    > = {};

    (links ?? []).forEach((l: Record<string, unknown>) => {
      const pid = l.product_id as string;
      result[pid] = {
        module_type: l.module_type as ModuleLinkTypeValue,
        entity_id: l.entity_id as string,
        config: (l.config ?? {}) as Record<string, unknown>,
      };
    });

    return result;
  }

  /**
   * Upload product file
   */
  async uploadProductFile(
    storeId: string,
    productId: string,
    file: Express.Multer.File,
  ) {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    const filePath = `${storeId}/products/${productId}/files/${timestamp}-${safeName}`;
    const result = await this.storageService.uploadFile(
      "stores",
      filePath,
      file,
      true,
    );

    return {
      url: result.url,
      path: result.path,
      asset: {
        url: result.url,
        file_name: result.file_name,
        file_size: result.size,
        mime_type: result.mime_type,
      },
    };
  }

  /**
   * Create a presigned URL so browsers can upload product files directly to R2.
   */
  async createProductFileUploadUrl(
    storeId: string,
    productId: string,
    file: {
      name: string;
      size: number;
      type: string;
    },
  ) {
    if (file.size > MAX_PRODUCT_FILE_SIZE) {
      throw Object.assign(
        new Error(`File size exceeds maximum of ${MAX_PRODUCT_FILE_SIZE_MB}MB`),
        { statusCode: 400 },
      );
    }

    if (!ALLOWED_PRODUCT_FILE_MIME_TYPES.includes(file.type)) {
      throw Object.assign(new Error(`File type ${file.type} is not allowed`), {
        statusCode: 400,
      });
    }

    const r2 = getR2Client();
    if (!r2) {
      throw Object.assign(new Error("R2 storage is not configured"), {
        statusCode: 500,
      });
    }

    const extension = file.name.split(".").pop()?.toLowerCase() || "bin";
    const key = `stores/${storeId}/products/${productId}/files/${randomUUID()}.${extension}`;

    const command = new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      ContentType: file.type,
    });

    const signedUrl = await getSignedUrl(r2, command, { expiresIn: 900 });
    const publicUrl = `${R2_PUBLIC_URL}/${key}`;

    return {
      bucket: R2_BUCKET_NAME,
      path: key,
      signedUrl,
      url: publicUrl,
      asset: {
        url: publicUrl,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
      },
    };
  }

  /**
   * Helper to strip sensitive fields from a product for public display
   */
  transformToPublicProduct(product: any): any {
    if (!product) return null;

    const publicProduct = { ...product };

    // Nullify sensitive digital asset links that shouldn't be public before purchase
    if (publicProduct.digital) {
      publicProduct.digital = {
        ...publicProduct.digital,
        download_url: null,
      };
    }

    if (publicProduct.digital) {
      publicProduct.digital = {
        ...publicProduct.digital,
        files: null,
      };
    }

    return publicProduct;
  }

  /**
   * Apply per-branch price/availability overrides (Branch-Aware Storefront)
   * to a list of products. Products with no override row for this branch
   * pass through unchanged (available everywhere, base price). Products
   * with `is_available: false` for this branch are dropped from the list.
   * No-op if branchId is omitted — existing unfiltered behaviour.
   */
  async applyBranchOverrides<
    T extends { id: string; price?: number; currency_prices?: any },
  >(products: T[], branchId?: string | null): Promise<T[]> {
    if (!branchId || products.length === 0) return products;

    const { data: overrides } = await this.supabase
      .from("branch_catalog_overrides")
      .select("product_id, is_available, price, currency_prices")
      .eq("branch_id", branchId)
      .in(
        "product_id",
        products.map((p) => p.id),
      );

    if (!overrides || overrides.length === 0) return products;

    const overrideMap = new Map(overrides.map((o: any) => [o.product_id, o]));
    const result: T[] = [];
    for (const product of products) {
      const override = overrideMap.get(product.id);
      if (!override) {
        result.push(product);
        continue;
      }
      if (override.is_available === false) continue;
      const updated: T = { ...product };
      if (override.price != null) (updated as any).price = override.price;
      if (override.currency_prices != null) {
        (updated as any).currency_prices = override.currency_prices;
      }
      result.push(updated);
    }
    return result;
  }

  /**
   * Get public product details
   */
  async getPublicProduct(
    slug: string,
    productId: string,
    branchId?: string | null,
  ): Promise<{
    store: Partial<StoreSettings> & { paystack_fee_bearer: FeeBearer };
    product: any;
  }> {
    // Get store with appearance
    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select(
        `
        id, name, slug, is_live, appearance,
        paystack_subaccount_code,
        business:business_id (
          id,
          name,
          paystack_subaccount_code,
          paystack_fee_bearer
        )
      `,
      )
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (storeError || !store) {
      throw Object.assign(new Error("Store not found or not live"), {
        statusCode: 404,
      });
    }

    // Resolve product by slug (new URLs) or UUID (legacy links)
    const UUID_PATTERN =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = UUID_PATTERN.test(productId);

    // Single product detail needs digital fields for transformToPublicProduct.
    const productQuery = this.supabase
      .from("products")
      .select(`${PRODUCT_PUBLIC_COLUMNS}, digital` as "*")
      .eq("store_id", store.id)
      .eq("status", "published")
      .eq("is_sellable", true);

    const { data: product, error: productError } = await (
      isUuid
        ? productQuery.eq("id", productId)
        : productQuery.eq("slug", productId)
    ).single();

    if (productError || !product) {
      throw Object.assign(new Error("Product not found or not published"), {
        statusCode: 404,
      });
    }

    // Use the resolved UUID for all subsequent lookups — productId may be a slug.
    const resolvedProductId = product.id;

    // Fetch categories
    const categories = await this.getProductCategories(resolvedProductId);

    let productWithCategories = {
      ...(product as Product),
      categories,
    };

    // If bundle, fetch products
    if (product.type === "bundle" && product.bundle?.product_ids?.length) {
      const { data: bundleProducts } = await this.supabase
        .from("products")
        .select("id, slug, name, price, cover_image")
        .in("id", product.bundle.product_ids);

      (productWithCategories as any).bundle_products = bundleProducts || [];
    }

    // Fetch availability profile if linked (or fallback to store default if product is a service)
    let profileId = product.availability_profile_id;
    if (!profileId && product.type === "service") {
      profileId = (store.appearance as any)?.availability_profile_id;
    }

    if (profileId) {
      const { data: availabilityProfile } = await this.supabase
        .from("availability_profiles")
        .select("*")
        .eq("id", profileId)
        .single();

      if (availabilityProfile) {
        (productWithCategories as any).availability_profile =
          availabilityProfile;
      }
    }

    // Fetch module link (unified)
    // includeMeta=true enriches with slug/url so the frontend can build correct redirect paths
    const publicModuleLink = await this.getProductModuleLink(
      resolvedProductId,
      true,
    );
    if (publicModuleLink) {
      (productWithCategories as any).module_link = publicModuleLink;
    }

    // Apply per-branch price/availability override, if any, before
    // stripping sensitive fields.
    const [overriddenProduct] = await this.applyBranchOverrides(
      [productWithCategories],
      branchId,
    );
    if (!overriddenProduct) {
      throw Object.assign(new Error("Product not available at this branch"), {
        statusCode: 404,
      });
    }

    // Strip sensitive fields before returning
    const safeProduct = this.transformToPublicProduct(overriddenProduct);

    // Resolve subaccount and fee bearer
    const businessData = Array.isArray(store.business)
      ? store.business[0]
      : store.business;

    const resolvedSubaccount =
      store.paystack_subaccount_code ||
      (businessData as any)?.paystack_subaccount_code;
    const resolvedFeeBearer = ((businessData as any)?.paystack_fee_bearer ||
      "subaccount") as FeeBearer;

    // Destructure to remove business from the rest to avoid type conflicts
    const { business, ...storeData } = store;

    const enhancedStore = {
      ...storeData,
      paystack_subaccount_code: resolvedSubaccount,
      paystack_fee_bearer: resolvedFeeBearer,
    };

    return { store: enhancedStore, product: safeProduct };
  }

  /**
   * Get store products with pagination
   */
  async getStoreProducts(
    storeId: string,
    params: {
      page: number;
      limit: number;
      status?: "published" | "draft";
      search?: string;
      category_id?: string;
      menu_id?: string;
      // Products with zero category assignments — invisible in the
      // Menu tab (which only browses by category) but still real/live,
      // so they need a dedicated way to surface them. See MenuList.tsx.
      uncategorized?: boolean;
    },
  ): Promise<{
    data: (Product & {
      sold_count: number;
      category_ids: string[];
      categories: Array<{ id: string; name: string; slug: string }>;
      variants: any[];
    })[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page, limit, status, search, category_id, menu_id, uncategorized } =
      params;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("products")
      .select(`${PRODUCT_PUBLIC_COLUMNS}, digital` as "*", {
        count: "exact",
      })
      .eq("store_id", storeId)
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
    }

    if (search) {
      // Match product name OR scanned barcode so a POS scanner can look up a
      // product by reading its barcode. Both filters use the same pattern so
      // the result set stays consistent across name and barcode searches.
      query = query.or(`name.ilike.%${search}%,barcode.ilike.%${search}%`);
    }

    if (uncategorized) {
      const { data: catLinks } = await this.supabase
        .from("product_categories")
        .select("product_id");
      const categorizedIds = [
        ...new Set((catLinks || []).map((c) => c.product_id)),
      ];
      if (categorizedIds.length > 0) {
        query = query.not("id", "in", `(${categorizedIds.join(",")})`);
      }
    } else if (category_id) {
      // Get product IDs for this category first
      const { data: catProducts } = await this.supabase
        .from("product_categories")
        .select("product_id")
        .eq("category_id", category_id);

      const ids = (catProducts || []).map((cp) => cp.product_id);
      query = query.in("id", ids);
    } else if (menu_id) {
      // Items in a menu = products whose category belongs to that menu.
      const { data: menuCategories } = await this.supabase
        .from("store_categories")
        .select("id")
        .eq("store_id", storeId)
        .eq("parent_id", menu_id);

      const categoryIds = (menuCategories || []).map((c) => c.id);
      if (categoryIds.length === 0) {
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }

      const { data: catProducts } = await this.supabase
        .from("product_categories")
        .select("product_id")
        .in("category_id", categoryIds);

      const ids = [...new Set((catProducts || []).map((cp) => cp.product_id))];
      if (ids.length === 0) {
        return { data: [], meta: { total: 0, page, limit, totalPages: 0 } };
      }
      query = query.in("id", ids);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    const products = (data as Product[]) || [];

    // Fetch categories for all products in batch
    const productIds = products.map((p) => p.id);
    let productCategories: Record<
      string,
      Array<{
        id: string;
        name: string;
        slug: string;
        parent_id: string | null;
      }>
    > = {};

    if (productIds.length > 0) {
      const { data: categoryData } = await this.supabase
        .from("product_categories")
        .select(
          "product_id, category:store_categories(id, name, slug, parent_id)",
        )
        .in("product_id", productIds);

      (categoryData || []).forEach((pc: any) => {
        if (!productCategories[pc.product_id]) {
          productCategories[pc.product_id] = [];
        }
        productCategories[pc.product_id].push(pc.category);
      });
    }

    const [moduleLinks, supplierIdsByProduct] = await Promise.all([
      this.batchFetchModuleLinks(productIds),
      this.getSupplierIdsByProduct(storeId, productIds),
    ]);

    // Batch-fetch variants — this list response never embedded them before,
    // so any UI reading `product.variants`/`product.stock` for a variant
    // product (e.g. InventoryManager's "On hand" column) silently saw "no
    // variants" and 0 stock even when the product genuinely has variants
    // with real stock. One extra batched query, same shape as categories
    // above, not N+1.
    let productVariants: Record<string, any[]> = {};
    if (productIds.length > 0) {
      const { data: variantData } = await this.supabase
        .from("product_variants")
        .select("*")
        .in("product_id", productIds)
        .order("position", { ascending: true });

      (variantData || []).forEach((v: any) => {
        if (!productVariants[v.product_id]) {
          productVariants[v.product_id] = [];
        }
        productVariants[v.product_id].push(v);
      });
    }

    const productsWithExtras = products.map((p) => ({
      ...(p as Product),
      sold_count: p.orders_count || 0,
      category_ids: (productCategories[p.id] || []).map((c) => c.id),
      categories: productCategories[p.id] || [],
      variants: productVariants[p.id] || [],
      supplier_ids: supplierIdsByProduct[p.id] ?? [],
      module_link: moduleLinks[p.id] ?? null,
    }));

    return {
      data: productsWithExtras,
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Get a single product with full details (management context)
   */
  async getStoreProduct(
    storeId: string,
    productId: string,
    businessId?: string,
  ): Promise<
    Product & { category_ids: string[]; categories: unknown[]; variants: unknown[] }
  > {
    // Validate store context
    await this.getStoreById(storeId, businessId);

    const { data: product, error } = await this.supabase
      .from("products")
      .select(PRODUCT_PUBLIC_COLUMNS as "*")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (error || !product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Fetch categories
    const categories = await this.getProductCategories(productId);

    // Fetch variants
    const { data: variants } = await supabaseAdmin
      .from("product_variants")
      .select(VARIANT_COLUMNS as "*")
      .eq("product_id", productId)
      .order("position", { ascending: true });

    const supplierIdsByProduct = await this.getSupplierIdsByProduct(storeId, [productId]);

    // Fetch module link (unified)
    // includeMeta=true enriches with slug/url so the frontend can build correct redirect paths
    const moduleLink = await this.getProductModuleLink(productId, true);

    return {
      ...product,
      category_ids: categories.map((c) => c.id),
      categories,
      variants: variants || [],
      supplier_ids: supplierIdsByProduct[productId] ?? [],
      module_link: moduleLink,
    };
  }

  async getProductDashboard(
    storeId: string,
    productId: string,
    businessId?: string,
  ): Promise<{
    product: Product & { category_ids: string[]; categories: unknown[]; variants: unknown[] };
    metrics: ProductDashboardMetrics;
    summary: {
      modifiers: {
        group_count: number;
        required_group_count: number;
        optional_group_count: number;
      };
      digital_delivery: {
        delivery_type: "upload" | "link" | null;
        download_limit: number | null;
        link_expiry_hours: number | null;
      } | null;
      curriculum: {
        module_count: number;
        lesson_count: number;
        certificate_enabled: boolean;
        active_enrolments: number;
        completion_rate: number | null;
      } | null;
      event_checkout: {
        collect_name: boolean;
        collect_email: boolean;
        collect_phone: boolean;
        collect_business_name: boolean;
        custom_question_count: number;
      };
      service_booking: {
        availability_profile: { id: string; name: string; timezone: string } | null;
        buffer_minutes: number | null;
        bookable_staff: Array<{ id: string; name: string; avatar_url: string | null }>;
      } | null;
    };
  }> {
    const product = await this.getStoreProduct(storeId, productId, businessId);
    const isCourse = product.module_link?.module_type === "course";
    const courseId = isCourse ? product.module_link?.entity_id : null;

    const [metricResult, modifierGroups, bookingResult, profileResult, staffResult, courseResult] = await Promise.all([
      this.supabase.rpc("get_product_dashboard_metrics", {
        p_store_id: storeId,
        p_product_id: productId,
      }),
      this.getProductModifierGroups(storeId, productId),
      product.type === "service"
        ? this.supabase
            .from("service_bookings")
            .select("status")
            .eq("store_id", storeId)
            .eq("product_id", productId)
        : Promise.resolve({ data: [], error: null }),
      product.type === "service" && product.availability_profile_id
        ? this.supabase
            .from("availability_profiles")
            .select("id, name, timezone, buffer_minutes")
            .eq("id", product.availability_profile_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      product.type === "service"
        ? this.supabase
            .from("product_bookable_staff")
            .select("staff_user_id")
            .eq("product_id", productId)
            .eq("is_active", true)
            .order("position", { ascending: true })
        : Promise.resolve({ data: [], error: null }),
      courseId
        ? this.supabase
            .from("courses")
            .select("id, module_count, lesson_count, certificate_enabled, enrollment_count, completed_count")
            .eq("id", courseId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (metricResult.error) throw metricResult.error;
    if (bookingResult.error) throw bookingResult.error;
    if (profileResult.error) throw profileResult.error;
    if (staffResult.error) throw staffResult.error;

    const metricRow = (metricResult.data?.[0] ?? {}) as ProductDashboardMetricRow;
    const bookings = bookingResult.data ?? [];
    const checkout = product.checkout;
    const staffIds = (staffResult.data ?? []).map((staff) => staff.staff_user_id);
    const { data: staffUsers, error: staffUsersError } = staffIds.length
      ? await this.supabase
          .from("users")
          .select("id, name, avatar_url")
          .in("id", staffIds)
      : { data: [], error: null };
    if (staffUsersError) throw staffUsersError;
    const staffById = new Map((staffUsers ?? []).map((staff) => [staff.id, staff]));
    const profile = profileResult.data;

    return {
      product,
      metrics: {
        units_sold: Number(metricRow.units_sold ?? 0),
        revenue: Number(metricRow.revenue ?? 0),
        customer_count: Number(metricRow.customer_count ?? 0),
        refunded_order_count: Number(metricRow.refunded_order_count ?? 0),
        pre_order_count: Number(metricRow.pre_order_count ?? 0),
        last_sale_at: metricRow.last_sale_at,
        ...(product.type === "service"
          ? {
              service: {
                bookings: bookings.length,
                no_shows: bookings.filter((booking) => booking.status === "no_show").length,
              },
            }
          : {}),
      },
      summary: {
        modifiers: this.summarizeModifierGroups(modifierGroups),
        digital_delivery:
          product.type === "digital"
            ? {
                delivery_type: product.digital?.delivery_type ?? null,
                download_limit: product.digital?.download_limit ?? null,
                link_expiry_hours: product.digital_link_expiry_hours ?? null,
              }
            : null,
        curriculum: courseResult.data
          ? {
              module_count: courseResult.data.module_count ?? 0,
              lesson_count: courseResult.data.lesson_count ?? 0,
              certificate_enabled: courseResult.data.certificate_enabled ?? false,
              active_enrolments: courseResult.data.enrollment_count ?? 0,
              completion_rate:
                (courseResult.data.enrollment_count ?? 0) > 0
                  ? (courseResult.data.completed_count ?? 0) / courseResult.data.enrollment_count
                  : null,
            }
          : null,
        event_checkout: {
          collect_name: checkout?.collectName ?? true,
          collect_email: checkout?.collectEmail ?? true,
          collect_phone: checkout?.collectPhone ?? true,
          collect_business_name: checkout?.collectBusinessName ?? false,
          custom_question_count: checkout?.customQuestions.length ?? 0,
        },
        service_booking:
          product.type === "service"
            ? {
                availability_profile: profile
                  ? { id: profile.id, name: profile.name, timezone: profile.timezone }
                  : null,
                buffer_minutes: profile?.buffer_minutes ?? null,
                bookable_staff: staffIds.flatMap((staffId) => {
                  const staff = staffById.get(staffId);
                  return staff
                    ? [{ id: staff.id, name: staff.name, avatar_url: staff.avatar_url ?? null }]
                    : [];
                }),
              }
            : null,
      },
    };
  }

  private summarizeModifierGroups(groups: ModifierGroup[]) {
    const requiredGroupCount = groups.filter(
      (group) => group.min_selections > 0,
    ).length;
    return {
      group_count: groups.length,
      required_group_count: requiredGroupCount,
      optional_group_count: groups.length - requiredGroupCount,
    };
  }

  /**
   * Get store orders with pagination
   */
  async getStoreOrders(
    storeId: string,
    params: {
      page: number;
      limit: number;
      status?: "paid" | "processing" | "fulfilled" | "cancelled" | "refunded";
      search?: string;
      branch_id?: string;
      product_id?: string;
    },
  ): Promise<{
    data: Order[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page, limit, status, search, branch_id, product_id } = params;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("store_orders")
      .select(ORDER_LIST_COLUMNS as "*", { count: "exact" })
      .eq("store_id", storeId)
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (status) {
      query = query.eq("status", status);
    }

    if (branch_id) {
      query = query.eq("branch_id", branch_id);
    }

    if (product_id) {
      const containedProduct = JSON.stringify([{ product_id }]);
      query = query.filter("items", "cs", containedProduct);
    }

    if (search) {
      // Search by customer name, email or order number
      query = query.or(
        `customer_name.ilike.%${search}%,customer_email.ilike.%${search}%,order_number.ilike.%${search}%`,
      );
    }

    const { data, error, count } = await query;

    if (error) throw error;

    // Transform flat customer columns to nested customer object
    const transformedData = (data || []).map((order: any) =>
      this.transformOrder(order),
    );

    return {
      data: transformedData as Order[],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  /**
   * Get a single store order by ID
   */
  async getStoreOrderById(storeId: string, orderId: string): Promise<Order> {
    const { data, error } = await this.supabase
      .from("store_orders")
      .select(ORDER_LIST_COLUMNS as "*")
      .eq("store_id", storeId)
      .eq("id", orderId)
      .single();

    if (error || !data) {
      throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    }

    return this.transformOrder(data);
  }

  /**
   * Get store discounts with pagination
   */
  async getStoreDiscounts(
    storeId: string,
    params: {
      page: number;
      limit: number;
      is_active?: boolean;
      kind?: "code" | "automatic";
      search?: string;
    },
  ): Promise<{
    data: DiscountCode[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page, limit, is_active, kind, search } = params;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS, { count: "exact" })
      .eq("store_id", storeId)
      .range(offset, offset + limit - 1)
      .order("created_at", { ascending: false });

    if (is_active !== undefined) {
      query = query.eq("is_active", is_active);
    }
    if (kind) query = query.eq("kind", kind);
    if (search) {
      query = query.or(`code.ilike.%${search}%,name.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    return {
      data: (data as unknown as DiscountCode[]) || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  /**
   * Charge-truth fields for foreign-currency orders: what the buyer's charge
   * was worth after the gateway took its fee. Empty for NGN orders (the
   * normalized accounting columns already are the charge) and whenever the
   * gateway fee is unknown — an absent figure beats an inflated one.
   */
  private buildChargedAmountFields(
    paymentData: NormalisedPaymentData,
    pendingCheckout: PendingCheckout | null,
  ): { charged_currency?: string; charged_net_total?: number } {
    const chargeCurrency = (
      pendingCheckout?.metadata?.currency ?? paymentData.currency
    )?.toUpperCase();
    if (!chargeCurrency || chargeCurrency === "NGN") return {};

    const grossKobo = pendingCheckout?.amount_kobo ?? paymentData.amount;
    const gatewayFeeKobo = paymentData.gatewayFee;
    if (gatewayFeeKobo == null) return {};

    return {
      charged_currency: chargeCurrency,
      charged_net_total: Number(
        ((grossKobo - gatewayFeeKobo) / 100).toFixed(2),
      ),
    };
  }

  /**
   * Create an order after payment verification
   */
  async createOrder(data: {
    store_id: string;
    payment_reference: string;
    payment_provider?: PaymentProviderName;
    customer: { name: string; email: string; phone?: string; address?: string };
    items: Array<{
      product_id: string;
      product_name: string;
      product_type:
        | "digital"
        | "physical"
        | "service"
        | "course"
        | "membership"
        | "bundle"
        | "donation";
      quantity: number;
      price: number;
      cover_image: string | null;
      slot: { startTime: string; endTime: string; date: string } | null;
      variant_id?: string | null;
    }>;
    // When set, a slot was pre-reserved via /bookings/reserve — confirm it
    // instead of creating a new booking record.
    booking_id?: string;
    discount_code?: string;
    delivery_provider?: string;
    delivery_service_code?: string;
    delivery_courier_id?: string;
    delivery_fee?: number;
    fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
    branch_id?: string;
    utensils_requested?: boolean;
    tax_amount?: number;
    notes?: string;
    qr_code_id?: string;
    location_label?: string;
  }): Promise<{ order: Order; downloadLinks?: string[] }> {
    // 0. Guard availability for service products.
    // Skip when a pre-reserved booking_id is provided — availability was
    // already validated at reservation time.
    if (!data.booking_id) {
      const availabilityService = new AvailabilityService(this.supabase);

      // Check product-specific availability for services (slot validation)
      for (const item of data.items) {
        if (item.product_type === "service") {
          if (!item.slot) {
            // Attempt to find a default slot if none provided (useful for webhooks)
            const defaultSlot = await this.findDefaultSlot(item.product_id);
            if (defaultSlot) {
              item.slot = defaultSlot;
              console.log(
                `[StoreService] Auto-assigned default slot to ${item.product_name}: ${item.slot.date} ${item.slot.startTime}`,
              );
            } else {
              throw Object.assign(
                new Error(
                  `Product ${item.product_name} requires a booking slot and no available slots were found for auto-assignment`,
                ),
                { statusCode: 400 },
              );
            }
          }
          const slotStatus = await availabilityService.validateSlotAvailability(
            item.product_id,
            item.slot,
          );
          if (!slotStatus.isAvailable) {
            throw Object.assign(
              new Error(
                `Selected slot for ${item.product_name} is unavailable: ${slotStatus.reason}`,
              ),
              { statusCode: 409 },
            );
          }
        }
      }
    } // end: !data.booking_id availability check

// Verify with the provider recorded on the checkout snapshot; only fall
    // back to the reference-prefix probe when no snapshot exists.
    const pendingCheckout = await pendingCheckoutService.findByReference(
      supabaseAdmin,
      data.payment_reference,
    );
    const provider = pendingCheckout
      ? PaymentProviderFactory.fromId(
          resolvePaymentProvider(
            String(pendingCheckout.metadata?.currency ?? "NGN"),
            pendingCheckout.metadata?.payment_provider as string | undefined,
          ),
        )
      : PaymentProviderFactory.getProviderForReference(data.payment_reference);
    const paymentData = await provider.verifyPayment(data.payment_reference);

    if (pendingCheckout) {
      paymentData.metadata = {
        ...paymentData.metadata,
        ...pendingCheckout.metadata,
      };
    }

    // Calculate totals
    const subtotal = data.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    const discountEvaluation = await this.evaluateDiscounts({
      storeId: data.store_id,
      customerEmail: data.customer.email,
      code: data.discount_code,
      items: data.items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        line_total: item.price * item.quantity,
      })),
    });
    const discount = discountEvaluation.discount_amount;

    const deliveryFee = Number(paymentData.metadata?.delivery_fee) || 0;
    const deliveryMethodName = paymentData.metadata?.delivery_name;
    const taxAmount = Number(paymentData.metadata?.tax_amount) || 0;
    const serviceChargeAmount =
      Number(paymentData.metadata?.service_charge_amount) || 0;

    const total =
      subtotal - discount + deliveryFee + taxAmount + serviceChargeAmount;

    const chargeCurrency = (paymentData.currency ||
      paymentData.metadata?.currency ||
      "NGN") as SupportedCurrency;
    let expectedAmount: number;

    if (pendingCheckout) {
      // The pending checkout captures the exact amount sent to the selected
      // provider after product currency overrides, FX, discounts, and fees.
      // Both Paystack and Flutterwave normalize verified amounts to ×100.
      expectedAmount = pendingCheckout.amount_kobo / 100;
    } else {
      // Legacy fallback for transactions created before pending_checkouts.
      // Prefer the checkout's converted-total snapshot. If it is absent, rebuild
      // the base using each product's explicit price for the charged currency,
      // falling back to FX only where the seller did not configure one.
      const rawConvertedSnapshot = paymentData.metadata?.converted_items_total;
      const convertedSnapshot = Number(rawConvertedSnapshot);
      const expectedBase =
        chargeCurrency !== "NGN" &&
        rawConvertedSnapshot != null &&
        Number.isFinite(convertedSnapshot)
          ? convertedSnapshot
          : chargeCurrency !== "NGN"
            ? await this.resolveLegacyRecoveryConvertedTotal({
                items: data.items,
                subtotalNGN: subtotal,
                discountNGN: discount,
                deliveryFeeNGN: deliveryFee,
                taxAmountNGN: taxAmount + serviceChargeAmount,
                targetCurrency: chargeCurrency,
              })
            : total;

      if (!Number.isFinite(expectedBase)) {
        throw Object.assign(
          new Error(
            `Unable to resolve the expected ${chargeCurrency} checkout amount`,
          ),
          { statusCode: 422 },
        );
      }

      const feeBearer = paymentData.metadata?.fee_bearer || "customer";
      expectedAmount = resolveCustomerCharge(expectedBase, feeBearer, {
        provider: resolvePaymentProvider(
          chargeCurrency,
          paymentData.metadata?.payment_provider,
        ),
        currency: chargeCurrency,
      }).totalToCharge;
    }

    if (!verifyPaymentAmount(paymentData.amount, expectedAmount)) {
      console.error(
        `[StoreService] Payment mismatch: paid=${paymentData.amount / 100}, expected=${expectedAmount}, currency=${chargeCurrency}, pending_checkout=${Boolean(pendingCheckout)}`,
      );
      throw Object.assign(
        new Error(
          `Payment amount (${paymentData.amount / 100} ${chargeCurrency}) does not match expected (${expectedAmount} ${chargeCurrency})`,
        ),
        { statusCode: 400 },
      );
    }

    let pricingSnapshot = paymentData.metadata?.pricing_snapshot;
    if (
      pricingSnapshot?.version !== 1 ||
      pricingSnapshot.currency !== chargeCurrency ||
      !Array.isArray(pricingSnapshot.items)
    ) {
      pricingSnapshot = await this.buildLegacyRecoveryPricingSnapshot({
        items: data.items,
        subtotalNGN: subtotal,
        discountNGN: discount,
        deliveryFeeNGN: deliveryFee,
        taxAmountNGN: taxAmount,
        serviceChargeAmountNGN: serviceChargeAmount,
        targetCurrency: chargeCurrency,
      });
      pricingSnapshot.platform_fee =
        Number(paymentData.metadata?.platform_fee) || 0;
      pricingSnapshot.provider_fee =
        Number(
          paymentData.metadata?.gateway_fee_estimate ??
            paymentData.metadata?.paystack_fee_estimate,
        ) || 0;
      pricingSnapshot.amount_sent_to_provider = paymentData.amount / 100;

      paymentData.metadata = {
        ...paymentData.metadata,
        converted_subtotal: pricingSnapshot.subtotal,
        converted_discount: pricingSnapshot.discount,
        converted_delivery_fee: pricingSnapshot.delivery.converted_amount,
        pricing_snapshot: pricingSnapshot,
      };

      if (pendingCheckout) {
        try {
          await pendingCheckoutService.updateMetadata(
            supabaseAdmin,
            data.payment_reference,
            {
              ...pendingCheckout.metadata,
              ...paymentData.metadata,
            },
          );
        } catch (snapshotError) {
          console.warn(
            `[StoreService] Could not persist legacy pricing snapshot for ${data.payment_reference}; fulfillment will continue`,
            snapshotError,
          );
        }
      }
    }

    const paidDeliveryFee = pricingSnapshot.delivery.converted_amount;
    const paidSubtotal = pricingSnapshot.subtotal;
    const paidDiscount = pricingSnapshot.discount;

    await this.decrementInventoryForOrderItems(data.items, data.branch_id, {
      reference_id: data.payment_reference,
      created_by: (data as any).user_id ?? null,
    });

    // Find user_id from email if available
    let userId = (data as any).user_id;
    if (!userId) {
      const { data: user } = await this.supabase
        .from("users")
        .select("id")
        .eq("email", data.customer.email)
        .single();
      if (user) userId = user.id;
    }

    // Determine if any items are pre-order products.
    // If so the order lands in 'pre_order' status; fulfilment is deferred until release.
    const productIds = data.items.map((i) => i.product_id);
    const { data: preOrderFlags } = await this.supabase
      .from("products")
      .select("id, is_pre_order, pre_order_release_date, pre_order_message")
      .in("id", productIds)
      .eq("is_pre_order", true);

    const isPreOrderBatch = (preOrderFlags?.length ?? 0) > 0;
    const orderStatus = isPreOrderBatch ? "pre_order" : "paid";

    // Attach pre-order metadata to each item for later reference
    const itemsWithPreOrderInfo = data.items.map((item) => {
      const preOrderInfo = preOrderFlags?.find((p) => p.id === item.product_id);
      return {
        ...item,
        is_pre_order: !!preOrderInfo,
        pre_order_release_date: preOrderInfo?.pre_order_release_date || null,
      };
    });

    // Create order
    const order: any = {
      // id: randomUUID(), // supbase should auto creates this.
      user_id: userId,
      store_id: data.store_id,
      order_number: generateOrderNumber(),
      customer_name: data.customer.name,
      customer_email: data.customer.email,
      customer_phone: data.customer.phone,
      customer_address: data.customer.address,
      items: itemsWithPreOrderInfo,
      subtotal,
      discount,
      discount_code: discountEvaluation.code_discount?.code ?? null,
      discount_details: discountEvaluation.discounts,
      delivery_fee: deliveryFee || undefined,
      tax_amount: taxAmount,
      service_charge_amount: serviceChargeAmount,
      // Preserve the existing NGN accounting semantics used by analytics,
      // bookkeeping, CRM, and revenue aggregation. The buyer's actual charge
      // is carried separately to email/recovery presentation.
      total,
      currency: "NGN",
      // Charge truth for foreign-currency orders (NULL for NGN, where the
      // normalized columns already are the charge): net of gateway fees, so
      // the figure reflects value actually received.
      ...this.buildChargedAmountFields(paymentData, pendingCheckout),
      status: orderStatus,
      payment_reference: data.payment_reference,
      payment_provider: paymentData.provider,
      shipping_carrier: deliveryMethodName || undefined,
      shipping_tracking_number: undefined,
      shipping_status: undefined,
      shipped_at: undefined,
      delivered_at: undefined,
      notes: data.notes || undefined,
      fulfillment_type: data.fulfillment_type || null,
      branch_id: data.branch_id || null,
      utensils_requested: data.utensils_requested ?? false,
      qr_code_id: data.qr_code_id || null,
      location_label: data.location_label || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      fulfilled_at: undefined,
    };

    const { data: savedOrder, error: orderError } = await this.supabase
      .from("store_orders")
      .insert([order])
      .select("*")
      .single();

    if (orderError) throw orderError;

    // Sync to bookkeeping (fire and forget). Uses the service-role client:
    // this route serves public checkout/webhooks where auth.uid() is null,
    // and the bookkeeping_transactions INSERT policy requires an owning user.
    const bookkeepingService = new BookkeepingService(supabaseAdmin);
    bookkeepingService
      .syncOrderIncome(savedOrder)
      .catch((err) =>
        console.error(
          "[StoreService.createOrder] Bookkeeping sync error:",
          err,
        ),
      );

    // supabaseAdmin: createOrder is a public (anon) route — auth.uid() is null,
    // so the RLS INSERT policy can't pass on the anon client.
    const bookingService = new BookingService(supabaseAdmin);

    if (data.booking_id) {
      // Confirm the pre-reserved pending booking created at checkout page load.
      try {
        await bookingService.confirmReservedBooking(
          data.booking_id,
          savedOrder.id,
          data.payment_reference,
          data.customer.name,
          data.customer.email,
          savedOrder.total * 100,
        );
      } catch (err) {
        console.error(
          "[StoreService] Failed to confirm pre-reserved booking:",
          err,
        );
      }
    } else {
      for (const item of data.items) {
        if (item.product_type === "service" && item.slot) {
          try {
            // Fetch product service details to check for approval requirement
            const { data: product } = await this.supabase
              .from("products")
              .select("service")
              .eq("id", item.product_id)
              .single();

            const approvalRequired =
              product?.service?.approval_required || false;
            const status = approvalRequired ? "pending" : "confirmed";

            const booking = await bookingService.createBooking({
              order_id: savedOrder.id,
              product_id: item.product_id,
              store_id: data.store_id,
              customer_email: data.customer.email,
              customer_name: data.customer.name,
              booking_date: item.slot.date,
              start_time: item.slot.startTime,
              end_time: item.slot.endTime,
              status,
              duration_minutes: 60,
              approval_required: approvalRequired,
              payment_amount: item.price ?? null,
              payment_reference: savedOrder.payment_reference ?? null,
              payment_status: "paid",
              paid_at: new Date().toISOString(),
            });

            // Send appropriate email
            const { data: store } = await this.supabase
              .from("stores")
              .select("name, business_id")
              .eq("id", data.store_id)
              .single();

            const validStoreName = store?.name || "Store";
            const businessId = store?.business_id;

            if (status === "pending") {
              await storeEmailService.sendBookingRequestReceived(
                booking,
                validStoreName,
                businessId,
              );
            } else {
              await storeEmailService.sendBookingConfirmation(
                booking,
                validStoreName,
                businessId,
              );
            }
          } catch (err) {
            console.error(
              `[StoreService] Failed to create booking and send email for item ${item.product_id}`,
              err,
            );
          }
        }
      }
    }

    // Finalize order (emails, stock, customer records, etc.)
    // For pre-orders skip download-link generation — product isn't released yet.
    await this.completeOrderFinalization(
      savedOrder,
      data.customer,
      itemsWithPreOrderInfo,
      discountEvaluation.discounts,
      {
        isPreOrder: isPreOrderBatch,
        paymentSummary: {
          amount: paymentData.amount / 100,
          currency: chargeCurrency,
          subtotal: paidSubtotal,
          discount: paidDiscount,
          deliveryFee: paidDeliveryFee,
          tax: pricingSnapshot.tax.converted_amount,
          serviceCharge: pricingSnapshot.service_charge.converted_amount,
          items: pricingSnapshot.items.map((item) => ({
            productId: item.product_id,
            name: item.product_name,
            variantName: item.variant_name,
            quantity: item.quantity,
            unitPrice: item.converted_unit_price,
            lineTotal: item.converted_line_total,
          })),
        },
      },
    );

    // Auto-create Shipbubble shipment if carrier rate was selected
    if (
      data.delivery_provider === "shipbubble" &&
      data.delivery_service_code &&
      data.delivery_courier_id
    ) {
      try {
        const physicalItems = itemsWithPreOrderInfo.filter(
          (i: any) => i.product_type === "physical",
        );
        if (physicalItems.length > 0) {
          const deliveryService = new DeliveryService();

          let businessSender: {
            name?: string;
            phone?: string;
            email?: string;
            address?: string;
          } = {};

          const { data: storeRecord } = await this.supabase
            .from("stores")
            .select("business_id")
            .eq("id", data.store_id)
            .single();

          if (storeRecord?.business_id) {
            const { data: business } = await this.supabase
              .from("businesses")
              .select("name, address")
              .eq("id", storeRecord.business_id)
              .single();

            if (business) {
              const addr = business.address as any;
              businessSender = {
                name: business.name || undefined,
                phone: addr?.phone || undefined,
                email: addr?.email || undefined,
                address: addr?.street
                  ? `${addr.street}, ${addr.city || ""}, ${addr.country || "NG"}`
                  : undefined,
              };
            }
          }

          const shipment = await deliveryService.createShipment({
            rate: {
              provider: data.delivery_provider,
              service_name: "",
              service_code: data.delivery_service_code,
              courier_id: data.delivery_courier_id,
              price: data.delivery_fee ?? 0,
              currency: "NGN",
              estimated_time: "",
            },
            destination: {
              name: data.customer.name,
              phone: data.customer.phone || "",
              email: data.customer.email,
              city: "",
              state: "",
              country: "NG",
              address_line_1: data.customer.address || "",
            },
            parcels: physicalItems.map((i: any) => ({
              name: i.product_name || "Item",
              quantity: i.quantity,
              weight: 0.5,
              declared_value: i.price,
            })),
            reference: savedOrder.order_number,
            sender: businessSender,
          });

          await this.supabase
            .from("store_orders")
            .update({
              shipping_tracking_number: shipment.order_id,
              shipping_carrier: `Shipbubble - ${shipment.courier_name}`,
              shipping_status: "pending",
              updated_at: new Date().toISOString(),
            })
            .eq("id", savedOrder.id);
        }
      } catch (err) {
        console.error(
          `[StoreService] Failed to auto-create Shipbubble shipment for order ${savedOrder.id}:`,
          err,
        );
      }
    }

    return { order: savedOrder as Order };
  }

  private async recordDiscountRedemptions(
    order: { id: string; store_id: string; currency?: string },
    customerEmail: string,
    discounts: AppliedDiscount[],
  ): Promise<void> {
    for (const discount of discounts) {
      const { data: recorded, error } = await this.supabase.rpc(
        "record_discount_redemption",
        {
          p_discount_id: discount.id,
          p_store_id: order.store_id,
          p_order_id: order.id,
          p_customer_email: customerEmail,
          p_amount: discount.amount,
          p_currency: order.currency || "NGN",
        },
      );

      if (error) throw error;
      if (recorded !== true) {
        throw Object.assign(
          new Error(`Discount ${discount.name} reached its usage limit`),
          { statusCode: 409 },
        );
      }
    }
  }

  /** Internal helper to complete order post-creation tasks. */
  private async completeOrderFinalization(
    savedOrder: any,
    customer: { name: string; email: string; phone?: string; address?: string },
    items: any[],
    appliedDiscounts: AppliedDiscount[],
    opts: {
      isPreOrder?: boolean;
      paymentSummary?: PaymentEmailSummary;
    } = {},
  ): Promise<void> {
    const storeId = savedOrder.store_id;
    const isPreOrder = opts.isPreOrder ?? false;

    // Upsert customer record
    await this.upsertCustomer(storeId, customer, savedOrder.total);

    await this.recordDiscountRedemptions(
      savedOrder,
      customer.email,
      appliedDiscounts,
    );

    // Get store info including owner details
    const { data: store } = await this.supabase
      .from("stores")
      .select("name, user_id, business_id, after_purchase")
      .eq("id", storeId)
      .single();

    const storeName = store?.name || "Store";
    const businessId = store?.business_id;

    // Emails must not break the order flow — a failed email is recoverable
    // via the admin resend endpoint; a broken order is not.
    try {
      await storeEmailService.sendOrderConfirmation(
        savedOrder as Order,
        storeName,
        businessId,
        store?.after_purchase?.thank_you_message,
        opts.paymentSummary,
      );
      // Use admin client — createOrder runs without an authenticated user,
      // so the anon client's RLS would block this update.
      supabaseAdmin
        .from("store_orders")
        .update({ confirmation_email_sent_at: new Date().toISOString() })
        .eq("id", savedOrder.id)
        .then(({ error }) => {
          if (error)
            console.error(
              "[StoreService] Failed to stamp email timestamp:",
              error,
            );
        });
    } catch (emailError) {
      console.error(
        `[StoreService] Order ${savedOrder.id}: customer confirmation email failed:`,
        emailError,
      );
    }

    if (store?.user_id) {
      try {
        const { data: owner } = await this.supabase
          .from("users")
          .select("email")
          .eq("id", store.user_id)
          .single();

        if (owner?.email) {
          await storeEmailService.sendNewOrderNotification(
            savedOrder as Order,
            owner.email,
            storeName,
            opts.paymentSummary,
          );
        }
      } catch (emailError) {
        console.error(
          `[StoreService] Order ${savedOrder.id}: owner notification email failed:`,
          emailError,
        );
      }
    }

    // For pre-orders: skip download delivery and auto-fulfilment.
    // Downloads will be sent and the order will be fulfilled when the creator
    // releases the product (via the new releasePreOrder endpoint).
    if (isPreOrder) {
      return;
    }

    // Handle digital products (including ebooks)
    const digitalItems = items.filter(
      (item) =>
        item.product_type === "digital",
    );

    if (digitalItems.length > 0) {
      try {
        const orderSuccessLink = `https://www.hilaq.com/order-success?reference=${savedOrder.payment_reference}`;
        await storeEmailService.sendDigitalProductLinks(
          savedOrder as Order,
          [orderSuccessLink],
          storeName,
          businessId,
        );
      } catch (emailError) {
        console.error(
          `[StoreService] Order ${savedOrder.id}: digital product links email failed:`,
          emailError,
        );
      }
    }

    // Auto-fulfill if all items are digital or ebooks
    const allDigital = items.every(
      (item) =>
        item.product_type === "digital",
    );
    if (allDigital) {
      await this.supabase
        .from("store_orders")
        .update({
          status: "fulfilled",
          fulfilled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", savedOrder.id);

      // Update object in memory
      savedOrder.status = "fulfilled";
      savedOrder.fulfilled_at = new Date().toISOString();
    }
  }

  /**
   * Release a pre-order product. Each waiting order has only this product's
   * items un-flagged; an order leaves `pre_order` only once none of its items
   * are still awaiting release. `released_count` counts orders moved into the
   * shipping flow (`paid`); `fulfilled_count` counts all-digital orders that
   * were auto-delivered and marked `fulfilled`.
   */
  async releasePreOrderProduct(
    storeId: string,
    productId: string,
    businessId?: string,
  ): Promise<{ released_count: number; fulfilled_count: number }> {
    const { data: orders, error } = await this.supabase
      .from("store_orders")
      .select("*")
      .eq("store_id", storeId)
      .eq("status", "pre_order");

    if (error) throw error;

    const matchingOrders = (orders || []).filter((order: any) =>
      (order.items || []).some((item: any) => item.product_id === productId),
    );

    if (matchingOrders.length === 0) {
      return { released_count: 0, fulfilled_count: 0 };
    }

    const { data: store } = await this.supabase
      .from("stores")
      .select("name, business_id")
      .eq("id", storeId)
      .single();

    const storeName = store?.name || "Store";
    const bid = businessId || store?.business_id;

    const { data: product } = await this.supabase
      .from("products")
      .select("id, type, name, pre_order_message")
      .eq("id", productId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    let releasedCount = 0;
    let fulfilledCount = 0;
    for (const order of matchingOrders) {
      try {
        const finalStatus = await this.releaseProductFromOrder(
          order,
          product,
          storeName,
          bid,
        );
        if (finalStatus === "fulfilled") fulfilledCount++;
        else if (finalStatus === "paid") releasedCount++;
      } catch (err) {
        console.error(
          `[StoreService.releasePreOrderProduct] Failed to release order ${order.id}:`,
          err,
        );
      }
    }

    await this.markProductReleased(productId);

    return { released_count: releasedCount, fulfilled_count: fulfilledCount };
  }

  /**
   * Release a single product's items within one order: deliver the product to
   * the buyer, un-flag its items, and persist the order's resulting status.
   * Returns the order's status after release.
   */
  private async releaseProductFromOrder(
    order: ReleasableOrder,
    product: ReleasableProduct,
    storeName: string,
    businessId?: string,
  ): Promise<ReleasedOrderStatus> {
    const releasedAt = new Date().toISOString();
    const items = (order.items || []).map((item) =>
      item.product_id === product.id
        ? { ...item, is_pre_order: false, released_at: releasedAt }
        : item,
    );

    await this.deliverReleasedProduct(order, product, storeName, businessId);

    const finalStatus = this.resolveReleasedOrderStatus(items);
    await this.persistOrderRelease(order.id, items, finalStatus, releasedAt);
    return finalStatus;
  }

  /**
   * Deliver a just-released product to the buyer: download links for
   * digital products, or a "being prepared" notice for everything else.
   */
  private async deliverReleasedProduct(
    order: ReleasableOrder,
    product: ReleasableProduct,
    storeName: string,
    businessId?: string,
  ): Promise<void> {
    const isDigitalDelivery =
      product.type === "digital";

    if (isDigitalDelivery) {
      const orderSuccessLink = `https://www.hilaq.com/order-success?reference=${order.payment_reference}`;
      await storeEmailService.sendDigitalProductLinks(
        order as unknown as Order,
        [orderSuccessLink],
        storeName,
        businessId,
      );
      return;
    }

    await storeEmailService.sendPreOrderReleaseNotification(
      order as unknown as Order,
      storeName,
      { itemNames: [product.name], message: product.pre_order_message ?? null },
      businessId,
    );
  }

  /**
   * An order stays `pre_order` while any item still awaits release; once all
   * are released it becomes `fulfilled` (all-digital, auto-delivered) or `paid`
   * (needs shipping).
   */
  private resolveReleasedOrderStatus(
    items: ReleasableOrderItem[],
  ): ReleasedOrderStatus {
    const stillAwaitingRelease = items.some(
      (item) => item.is_pre_order === true,
    );
    if (stillAwaitingRelease) return "pre_order";
    return this.isDigitalOnlyOrder(items) ? "fulfilled" : "paid";
  }

  private isDigitalOnlyOrder(items: ReleasableOrderItem[]): boolean {
    return (
      items.length > 0 &&
      items.every(
        (item) =>
          item.product_type === "digital",
      )
    );
  }

  private async persistOrderRelease(
    orderId: string,
    items: ReleasableOrderItem[],
    status: ReleasedOrderStatus,
    timestamp: string,
  ): Promise<void> {
    const updates: Record<string, unknown> = {
      items,
      status,
      updated_at: timestamp,
    };
    if (status === "fulfilled") {
      updates.fulfilled_at = timestamp;
    }

    const { error } = await this.supabase
      .from("store_orders")
      .update(updates)
      .eq("id", orderId);
    if (error) throw error;
  }

  /** Mark the product as no longer a pre-order, keeping fields for auditing. */
  private async markProductReleased(productId: string): Promise<void> {
    const now = new Date().toISOString();
    const { error } = await this.supabase
      .from("products")
      .update({ is_pre_order: false, released_at: now, updated_at: now })
      .eq("id", productId);
    if (error) throw error;
  }

  /**
   * Process a free purchase (total is 0, bypasses Paystack)
   */
  async processFreePurchase(data: {
    store_id: string;
    user_id?: string;
    customer: { name: string; email: string; phone?: string; address?: string };
    items: Array<{
      product_id: string;
      variant_id?: string | null;
      quantity: number;
      price?: number | null;
      slot?: { startTime: string; endTime: string; date: string } | null;
      selected_modifiers?: Array<{
        modifier_option_id: string;
        quantity?: number;
      }>;
      note?: string | null;
    }>;
    discount_code?: string;
    delivery_method_id?: string;
    delivery_fee?: number;
    delivery_provider?: string;
    delivery_service_code?: string;
    delivery_courier_id?: string;
    delivery_city?: string;
    delivery_state?: string;
    fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
    branch_id?: string;
    utensils_requested?: boolean;
    notes?: string;
  }): Promise<{ order: Order }> {
    if (data.branch_id) {
      await this.assertBranchAcceptingOrders(data.branch_id);
    }

    // 0. Guard availability for service products
    const availabilityService = new AvailabilityService(this.supabase);

    // Fetch product details and validate
    const productIds = data.items.map((i) => i.product_id);
    const { data: products, error: productsError } = await this.supabase
      .from("products")
      .select(
        "id, name, price, stock, status, type, cover_image, orders_count, service, donation, allow_custom_price, lead_time_hours, min_order_quantity, max_order_quantity, quantity_step",
      )
      .in("id", productIds)
      .eq("status", "published")
      .eq("is_sellable", true);

    if (productsError) throw productsError;
    if (!products || products.length !== productIds.length) {
      throw Object.assign(
        new Error("One or more products not found or not published"),
        { statusCode: 404 },
      );
    }

    // Per-branch lead-time overrides — see resolveStoreCharge for why this
    // takes precedence over the product's own lead_time_hours.
    let branchLeadTimeByProduct = new Map<string, number | null>();
    if (data.branch_id) {
      const { data: overrides } = await this.supabase
        .from("branch_catalog_overrides")
        .select("product_id, lead_time_hours")
        .eq("branch_id", data.branch_id)
        .in("product_id", productIds);
      for (const o of overrides || []) {
        branchLeadTimeByProduct.set(o.product_id, o.lead_time_hours);
      }
    }

    for (const item of data.items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) continue;
      const effectiveLeadTime =
        branchLeadTimeByProduct.get(item.product_id) ?? product.lead_time_hours;
      if (effectiveLeadTime) {
        this.assertLeadTimeMet(product.name, effectiveLeadTime, item.slot);
      }
      this.assertQuantityConstraints(product.name, item.quantity, product);
    }

    // Fetch variants if any
    const variantIds = data.items
      .filter((i) => i.variant_id)
      .map((i) => i.variant_id!);
    let variants: any[] = [];
    if (variantIds.length > 0) {
      const { data: variantData } = await this.supabase
        .from("product_variants")
        .select("id, product_id, name, price_adjustment, stock")
        .in("id", variantIds)
        .eq("is_active", true);
      variants = variantData || [];
    }

    // Prepare items and calculate total
    const fullItems = await Promise.all(
      data.items.map(async (item) => {
        const product = products.find((p: any) => p.id === item.product_id)!;
        const buyerSetsPrice = this.buyerSetsPrice(product);
        let finalPrice = buyerSetsPrice
          ? this.resolveBuyerSetPrice(product, item.price)
          : product.price;

        // A buyer-set price is the full amount they chose; variant adjustments
        // don't stack on top of it.
        if (item.variant_id && !buyerSetsPrice) {
          const variant = variants.find((v) => v.id === item.variant_id);
          if (variant) finalPrice += variant.price_adjustment;
        }

        const { priceDelta: modifierPriceDelta, resolved: selectedModifiers } =
          !buyerSetsPrice
            ? await this.resolveSelectedModifiers(
                item.product_id,
                item.selected_modifiers,
                data.branch_id,
              )
            : { priceDelta: 0, resolved: [] };
        finalPrice += modifierPriceDelta;

        return {
          product_id: item.product_id,
          product_name: product.name,
          product_type: product.type as
            | "digital"
            | "physical"
            | "service"
            | "membership"
            | "bundle"
            | "donation",
          quantity: item.quantity,
          price: finalPrice,
          cover_image: product.cover_image,
          slot: item.slot || null,
          variant_id: item.variant_id || null,
          service: product.service,
          selected_modifiers: selectedModifiers,
          note: item.note || null,
        };
      }),
    );

    const subtotal = fullItems.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );
    const discountEvaluation = await this.evaluateDiscounts({
      storeId: data.store_id,
      customerEmail: data.customer.email,
      code: data.discount_code,
      items: fullItems.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        line_total: item.price * item.quantity,
      })),
    });
    const discount = discountEvaluation.discount_amount;

    const total = subtotal - discount;

    if (total > 0) {
      throw Object.assign(
        new Error("Cannot process non-free purchase through free channel"),
        { statusCode: 400 },
      );
    }

    for (const item of fullItems) {
      if (item.product_type === "service" && item.slot) {
        const slotStatus = await availabilityService.validateSlotAvailability(
          item.product_id,
          item.slot,
        );
        if (!slotStatus.isAvailable) {
          throw Object.assign(
            new Error(
              `Selected slot for ${item.product_name} is unavailable: ${slotStatus.reason}`,
            ),
            { statusCode: 409 },
          );
        }
      }
    }

    await this.decrementInventoryForOrderItems(fullItems, data.branch_id, {
      created_by: (data as any).user_id ?? null,
    });

    // Try to find user_id from email
    const { data: user } = await this.supabase
      .from("users")
      .select("id")
      .eq("email", data.customer.email)
      .single();

    // Create order
    const order: any = {
      user_id: user?.id || (data as any).user_id,
      store_id: data.store_id,
      order_number: generateOrderNumber(),
      customer_name: data.customer.name,
      customer_email: data.customer.email,
      customer_phone: data.customer.phone,
      customer_address: data.customer.address,
      items: fullItems,
      subtotal,
      discount,
      discount_code: discountEvaluation.code_discount?.code ?? null,
      discount_details: discountEvaluation.discounts,
      total: 0,
      currency: "NGN",
      status: "paid",
      payment_reference: createTransactionReference(REFERENCE_TYPES.ORDER),
      fulfillment_type: data.fulfillment_type || null,
      branch_id: data.branch_id || null,
      utensils_requested: data.utensils_requested ?? false,
      notes: data.notes || undefined,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { data: savedOrder, error: orderError } = await this.supabase
      .from("store_orders")
      .insert([order])
      .select("*")
      .single();

    if (orderError) throw orderError;

    // Create bookings for service items
    console.log(
      `[StoreService.processFreePurchase] About to create bookings for ${fullItems.length} items`,
    );
    // supabaseAdmin: processFreePurchase is a public (anon) route — auth.uid()
    // is null, so the RLS INSERT policy can't pass on the anon client.
    const bookingService = new BookingService(supabaseAdmin);
    for (const item of fullItems) {
      if (item.product_type === "service" && item.slot) {
        try {
          const approvalRequired =
            (item as any).service?.approval_required || false;
          const status = approvalRequired ? "pending" : "confirmed";

          const booking = await bookingService.createBooking({
            order_id: savedOrder.id,
            product_id: item.product_id,
            store_id: data.store_id,
            customer_email: data.customer.email,
            customer_name: data.customer.name,
            booking_date: item.slot.date,
            start_time: item.slot.startTime,
            end_time: item.slot.endTime,
            status,
            duration_minutes: 60,
            approval_required: approvalRequired,
          });

          // Fetch store info for email
          const { data: store } = await this.supabase
            .from("stores")
            .select("name, business_id")
            .eq("id", data.store_id)
            .single();

          const validStoreName = store?.name || "Store";
          const businessId = store?.business_id;

          if (status === "pending") {
            await storeEmailService.sendBookingRequestReceived(
              booking,
              validStoreName,
              businessId,
            );
          } else {
            await storeEmailService.sendBookingConfirmation(
              booking,
              validStoreName,
              businessId,
            );
          }
        } catch (err) {
          console.error(
            `[StoreService] Failed to create booking for free item ${item.product_id}`,
            err,
          );
        }
      }
    }

    // Finalize
    await this.completeOrderFinalization(
      savedOrder,
      data.customer,
      fullItems,
      discountEvaluation.discounts,
    );

    // Handle digital products (including ebooks) — mirror the webhook path in
    // createOrder: email download links and auto-fulfill all-digital orders so
    // Free digital orders don't land in the physical/shipping workflow.
    const digitalItems = fullItems.filter(
      (item) =>
        item.product_type === "digital",
    );

    if (digitalItems.length > 0) {
      try {
        const { data: store } = await this.supabase
          .from("stores")
          .select("name, business_id")
          .eq("id", data.store_id)
          .single();

        const orderSuccessLink = `https://www.hilaq.com/order-success?reference=${savedOrder.payment_reference}`;
        await storeEmailService.sendDigitalProductLinks(
          savedOrder as Order,
          [orderSuccessLink],
          store?.name || "Store",
          store?.business_id,
        );
      } catch (emailError) {
        console.error(
          `[StoreService] Order ${savedOrder.id}: digital product links email failed:`,
          emailError,
        );
      }
    }

    // Auto-fulfill if all items are digital or ebooks. This is a public (anon)
    // route, so the status update goes through supabaseAdmin like the booking
    // creation above.
    const allDigital = fullItems.every(
      (item) =>
        item.product_type === "digital",
    );
    if (allDigital) {
      const fulfilledAt = new Date().toISOString();
      await supabaseAdmin
        .from("store_orders")
        .update({
          status: "fulfilled",
          fulfilled_at: fulfilledAt,
          updated_at: fulfilledAt,
        })
        .eq("id", savedOrder.id);

      savedOrder.status = "fulfilled";
      savedOrder.fulfilled_at = fulfilledAt;
    }

    return { order: savedOrder as Order };
  }

  /**
   * Update order status
   */
  async updateOrderStatus(
    storeId: string,
    orderId: string,
    status: "paid" | "processing" | "fulfilled" | "cancelled" | "refunded",
  ): Promise<Order> {
    const { data: existing, error: existingError } = await this.supabase
      .from("store_orders")
      .select("*")
      .eq("id", orderId)
      .eq("store_id", storeId)
      .single();

    if (existingError) throw existingError;
    if (!existing) {
      throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    }

    if (existing.status === "pre_order") {
      throw Object.assign(
        new Error(
          "This order has pre-order items. Release the product before updating its status.",
        ),
        { statusCode: 409 },
      );
    }

    const updates: any = {
      status,
      updated_at: new Date().toISOString(),
    };

    if (status === "fulfilled" && !existing.fulfilled_at) {
      updates.fulfilled_at = new Date().toISOString();
    }

    const { data, error } = await this.supabase
      .from("store_orders")
      .update(updates)
      .eq("id", orderId)
      .select("*")
      .single();

    if (error) throw error;

    // Sync to bookkeeping (fire and forget). Service-role client — see the
    // note in createOrder; status updates can also originate from webhook or
    // staff contexts without an owning-user JWT.
    if (status === "paid" || status === "fulfilled") {
      const bookkeepingService = new BookkeepingService(supabaseAdmin);
      bookkeepingService
        .syncOrderIncome(data)
        .catch((err) =>
          console.error(
            "[StoreService.updateOrderStatus] Bookkeeping sync error:",
            err,
          ),
        );
    }

    // Send fulfillment email if status changed to fulfilled
    if (status === "fulfilled" && existing.status !== "fulfilled") {
      const { data: store } = await this.supabase
        .from("stores")
        .select("name, business_id")
        .eq("id", storeId)
        .single();

      await storeEmailService.sendFulfillmentNotification(
        data as Order,
        store?.name || "Store",
        store?.business_id,
      );
    }

    // Decrement orders_count if order is cancelled or refunded
    // Only if it was previously in a state that counted as a sale (paid, processing, fulfilled)
    const wasCounted = ["paid", "processing", "fulfilled"].includes(
      existing.status,
    );
    const isCancelled = ["cancelled", "refunded"].includes(status);

    if (wasCounted && isCancelled) {
      console.log(
        `[StoreService] Order ${orderId} cancelled/refunded. Decrementing product counts.`,
      );
      const items = existing.items as any[]; // strict typing skipped for simplicity
      if (Array.isArray(items)) {
        for (const item of items) {
          if (item.product_id && item.quantity) {
            const { data: product } = await this.supabase
              .from("products")
              .select("orders_count")
              .eq("id", item.product_id)
              .single();

            if (product) {
              await this.supabase
                .from("products")
                .update({
                  orders_count: Math.max(
                    0,
                    Number(product.orders_count || 0) - Number(item.quantity),
                  ),
                })
                .eq("id", item.product_id);
            }
          }
        }
      }
    }

    return this.transformOrder(data);
  }

  /**
   * Update order shipping info
   */
  async updateOrderShipping(
    storeId: string,
    orderId: string,
    updates: {
      tracking_number?: string;
      status?:
        | "pending"
        | "processing"
        | "ready_for_pickup"
        | "shipped"
        | "delivered";
      shipped_at?: string;
      delivered_at?: string;
    },
  ): Promise<Order> {
    const { data: existing, error: existingError } = await this.supabase
      .from("store_orders")
      .select("*")
      .eq("id", orderId)
      .eq("store_id", storeId)
      .single();

    if (existingError) throw existingError;
    if (!existing) {
      throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    }

    const shippingUpdates: any = {
      updated_at: new Date().toISOString(),
    };

    if (updates.tracking_number) {
      shippingUpdates.shipping_tracking_number = updates.tracking_number;
    }
    if (updates.status) {
      shippingUpdates.shipping_status = updates.status;

      // Automatically move order status to processing if it's paid and we are processing for shipping/pickup
      if (
        existing.status === "paid" &&
        (updates.status === "processing" ||
          updates.status === "ready_for_pickup")
      ) {
        shippingUpdates.status = "processing";
      }
    }
    if (updates.shipped_at) {
      shippingUpdates.shipped_at = updates.shipped_at;
    }
    if (updates.delivered_at) {
      shippingUpdates.delivered_at = updates.delivered_at;
    }

    const { data, error } = await this.supabase
      .from("store_orders")
      .update(shippingUpdates)
      .eq("id", orderId)
      .select("*")
      .single();

    if (error) throw error;

    // Send shipping update email if tracking number was added or status changed
    if (updates.tracking_number || updates.status) {
      const { data: store } = await this.supabase
        .from("stores")
        .select("name, business_id")
        .eq("id", storeId)
        .single();

      await storeEmailService.sendShippingUpdate(
        data as Order,
        store?.name || "Store",
        store?.business_id,
      );
    }

    return this.transformOrder(data);
  }

  /**
   * Update order shipping info by Shipbubble order ID (stored in shipping_tracking_number)
   * Used by webhook handler to update shipping status from Shipbubble events
   */
  async updateOrderShippingByShipbubbleId(
    shipbubbleOrderId: string,
    updates: {
      tracking_number?: string;
      status?:
        | "pending"
        | "processing"
        | "ready_for_pickup"
        | "shipped"
        | "delivered";
      shipped_at?: string;
      delivered_at?: string;
    },
  ): Promise<void> {
    const { data: order, error: findError } = await this.supabase
      .from("store_orders")
      .select("id, store_id, status")
      .eq("shipping_tracking_number", shipbubbleOrderId)
      .single();

    if (findError || !order) {
      console.error(
        `Order not found for Shipbubble ID: ${shipbubbleOrderId}`,
        findError?.message || "",
      );
      return;
    }

    const shippingUpdates: any = {
      updated_at: new Date().toISOString(),
    };

    if (updates.tracking_number) {
      shippingUpdates.shipping_tracking_number = updates.tracking_number;
    }
    if (updates.status) {
      shippingUpdates.shipping_status = updates.status;
      if (
        order.status === "paid" &&
        (updates.status === "processing" ||
          updates.status === "ready_for_pickup")
      ) {
        shippingUpdates.status = "processing";
      }
      if (updates.status === "delivered") {
        shippingUpdates.status = "fulfilled";
      }
    }
    if (updates.shipped_at) {
      shippingUpdates.shipped_at = updates.shipped_at;
    }
    if (updates.delivered_at) {
      shippingUpdates.delivered_at = updates.delivered_at;
    }

    const { error: updateError } = await this.supabase
      .from("store_orders")
      .update(shippingUpdates)
      .eq("id", order.id);

    if (updateError) {
      console.error(
        `Failed to update shipping for order ${order.id}:`,
        updateError.message,
      );
    }
  }

  /**
   * Helper to transform flat database order to nested structure expected by frontend
   */
  private transformOrder(order: any): Order {
    if (!order) return order;
    return {
      ...order,
      customer: {
        name: order.customer_name,
        email: order.customer_email,
        phone: order.customer_phone,
        address: order.customer_address,
      },
    } as Order;
  }

  /**
   * Add note to order
   */
  async updateOrderNote(
    storeId: string,
    orderId: string,
    note: string,
  ): Promise<Order> {
    const { data, error } = await this.supabase
      .from("store_orders")
      .update({
        notes: note,
        updated_at: new Date().toISOString(),
      })
      .eq("id", orderId)
      .eq("store_id", storeId)
      .select("*")
      .single();

    if (error) throw error;
    if (!data) {
      throw Object.assign(new Error("Order not found"), { statusCode: 404 });
    }

    return data as Order;
  }

  /**
   * Get purchases made by a user (orders with product metadata)
   */
  async getUserPurchases(params: {
    userId: string;
    email?: string | null;
    orderId?: string | null;
  }): Promise<any[]> {
    const { userId, email, orderId } = params;

    let query = this.supabase
      .from("store_orders")
      .select(`*, store:stores(id, name, slug, appearance)`)
      .order("created_at", { ascending: false });

    if (email) {
      query = query.or(`user_id.eq.${userId},customer_email.eq.${email}`);
    } else {
      query = query.eq("user_id", userId);
    }

    if (orderId) {
      query = query.eq("id", orderId);
    }

    const { data: orders, error: orderError } = await query;
    if (orderError) throw orderError;

    const productIds = new Set<string>();
    (orders || []).forEach((order: any) => {
      if (Array.isArray(order.items)) {
        order.items.forEach((item: any) => {
          if (item?.product_id) productIds.add(item.product_id);
        });
      }
    });

    const productMap = new Map<string, any>();
    if (productIds.size > 0) {
      const { data: products, error: productsError } = await this.supabase
        .from("products")
        .select("*")
        .in("id", Array.from(productIds));
      if (productsError) throw productsError;
      (products || []).forEach((product: any) => {
        productMap.set(product.id, product);
      });
    }

    const enriched = (orders || []).map((order: any) => {
      const products = (order.items || []).map((item: any) => {
        const product = item?.product_id
          ? productMap.get(item.product_id)
          : null;
        if (product) return product;
        return {
          id: item?.product_id || `missing-${item?.product_name}`,
          store_id: order.store_id,
          name: item?.product_name || "Unknown",
          description: "",
          price: item?.price || 0,
          compare_at_price: null,
          currency: order.currency || "NGN",
          type: item?.product_type || "digital",
          status: "published",
          cover_image: item?.cover_image || null,
          images: [],
          stock: null,
          sku: null,
          orders_count: 0,
          sold_count: 0,
          variants: [],
          created_at: order.created_at,
          updated_at: order.updated_at,
        };
      });
      const appearance = order.store?.appearance || {};
      return {
        ...order,
        store: order.store
          ? {
              id: order.store.id,
              name: order.store.name,
              slug: order.store.slug,
              accent_color: appearance.accent_color || null,
            }
          : null,
        products,
      };
    });

    return enriched;
  }

  // ============================================================================
  // Discount Code Management
  // ============================================================================

  /**
   * Add discount code
   */
  async addDiscountCode(
    storeId: string,
    code: Omit<
      DiscountCode,
      "id" | "store_id" | "created_at" | "updated_at" | "usage_count"
    >,
  ): Promise<DiscountCode> {
    if (code.kind === "code" && code.code) {
      const { data: existing } = await this.supabase
        .from("discount_codes")
        .select("id")
        .eq("store_id", storeId)
        .ilike("code", code.code)
        .maybeSingle();

      if (existing) {
        throw Object.assign(new Error("Discount code already exists"), {
          statusCode: 409,
        });
      }
    }

    const newCode = DiscountCodeSchema.parse({
      store_id: storeId,
      ...code,
      usage_count: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    const { data, error } = await this.supabase
      .from("discount_codes")
      .insert([newCode])
      .select(DISCOUNT_COLUMNS)
      .single();

    if (error) throw error;
    return data as unknown as DiscountCode;
  }

  /**
   * Update discount code
   */
  async updateDiscountCode(
    storeId: string,
    codeId: string,
    updates: Partial<DiscountCode>,
  ): Promise<DiscountCode> {
    const { data: existing, error: existingError } = await this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS)
      .eq("id", codeId)
      .eq("store_id", storeId)
      .single();

    if (existingError) throw existingError;
    if (!existing) {
      throw Object.assign(new Error("Discount code not found"), {
        statusCode: 404,
      });
    }

    const existingDiscount = existing as unknown as DiscountCode;
    const updated = DiscountCodeSchema.parse({
      ...existingDiscount,
      ...updates,
      id: codeId,
      store_id: storeId,
      updated_at: new Date().toISOString(),
    });

    const { data, error } = await this.supabase
      .from("discount_codes")
      .update(updated)
      .eq("id", codeId)
      .select(DISCOUNT_COLUMNS)
      .single();

    if (error) throw error;
    return data as unknown as DiscountCode;
  }

  /**
   * Delete discount code
   */
  async deleteDiscountCode(storeId: string, codeId: string): Promise<void> {
    const { error } = await this.supabase
      .from("discount_codes")
      .delete()
      .eq("id", codeId)
      .eq("store_id", storeId);

    if (error) throw error;
  }

  /**
   * Validate discount code
   */
  async validateDiscountCode(
    storeId: string,
    code: string,
    args: {
      subtotal?: number;
      items?: { product_id: string; line_total: number }[];
    },
  ): Promise<{ valid: boolean; discountAmount: number; message?: string }> {
    const { data: discountData, error } = await this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS)
      .eq("store_id", storeId)
      .eq("code", code)
      .single();

    if (error || !discountData) {
      return {
        valid: false,
        discountAmount: 0,
        message: "Invalid discount code",
      };
    }

    const discount = discountData as unknown as DiscountCode;

    if (!isDiscountValid(discount)) {
      if (!discount.is_active) {
        return {
          valid: false,
          discountAmount: 0,
          message: "Discount code is inactive",
        };
      }
      if (discount.max_usage && discount.usage_count >= discount.max_usage) {
        return {
          valid: false,
          discountAmount: 0,
          message: "Discount code usage limit reached",
        };
      }
      if (discount.expires_at && new Date(discount.expires_at) < new Date()) {
        return {
          valid: false,
          discountAmount: 0,
          message: "Discount code has expired",
        };
      }
    }

    let eligibleSubtotal: number;
    if (args.items) {
      eligibleSubtotal = calculateEligibleSubtotal(
        args.items.map((i) => ({
          product_id: i.product_id,
          lineTotal: i.line_total,
        })),
        discount,
      );
    } else if (discount.applies_to === "all") {
      eligibleSubtotal = args.subtotal ?? 0;
    } else {
      return {
        valid: false,
        discountAmount: 0,
        message: "This code applies to specific products",
      };
    }

    if (eligibleSubtotal <= 0) {
      return {
        valid: false,
        discountAmount: 0,
        message: "No eligible items for this code",
      };
    }

    const discountAmount = calculateDiscount(
      eligibleSubtotal,
      discount.type,
      discount.value,
    );

    return { valid: true, discountAmount };
  }

  async isDiscountApplicable(
    storeId: string,
    productIds: string[],
  ): Promise<boolean> {
    const ids = productIds
      .filter((id) => id)
      .map((id) => `"${id}"`)
      .join(",");
    const filter = `applies_to.eq.all,product_ids.ov.{${ids}}`;
    const { data: codes, error } = await this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS)
      .eq("store_id", storeId)
      .eq("is_active", true)
      .or(filter)
      .limit(50);

    if (error || !codes || codes.length === 0) return false;

    return codes.some((row: any) => {
      const code = row as DiscountCode;
      if (!isDiscountValid(code)) return false;
      if (code.applies_to === "all") return true;
      return code.product_ids.some((pid: string) => productIds.includes(pid));
    });
  }

  async evaluateDiscounts(input: {
    storeId: string;
    items: DiscountEvaluationItem[];
    customerEmail?: string;
    code?: string;
  }): Promise<DiscountEvaluation> {
    return new DiscountService(this.supabase).evaluate(input);
  }

  // ============================================================================
  // Store Deletion
  // ============================================================================

  /**
   * Delete a store (only if no products or orders exist)
   */
  async deleteStore(
    userId: string,
    storeId: string,
    businessId?: string,
  ): Promise<void> {
    // Validate ownership
    await this.validateStoreOwnership(storeId, userId, businessId);

    // Get store
    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("id")
      .eq("id", storeId)
      .single();

    if (storeError || !store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    // Check for products
    const { count: productsCount } = await this.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", store.id);

    if (productsCount && productsCount > 0) {
      throw Object.assign(
        new Error(
          `Cannot delete store with ${productsCount} product(s). Delete all products first.`,
        ),
        { statusCode: 400 },
      );
    }

    // Check for orders
    const { count: ordersCount } = await this.supabase
      .from("store_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", store.id);

    if (ordersCount && ordersCount > 0) {
      throw Object.assign(
        new Error(
          `Cannot delete store with ${ordersCount} order(s). Contact support for assistance.`,
        ),
        { statusCode: 400 },
      );
    }

    // Safe to delete
    const { error: deleteError } = await this.supabase
      .from("stores")
      .delete()
      .eq("id", store.id);

    if (deleteError) throw deleteError;
  }

  // ============================================================================
  // Customer Management
  // ============================================================================

  /**
   * Upsert customer record when order is created
   */
  async upsertCustomer(
    storeId: string,
    customer: { name: string; email: string; phone?: string; address?: string },
    orderTotal: number,
  ): Promise<void> {
    // Try to find existing customer
    const { data: existing } = await this.supabase
      .from("store_customers")
      .select("id, orders_count, lifetime_value, phone, address")
      .eq("store_id", storeId)
      .eq("email", customer.email)
      .single();

    if (existing) {
      // Update existing customer
      await this.supabase
        .from("store_customers")
        .update({
          name: customer.name,
          phone: customer.phone || existing.phone,
          address: customer.address || existing.address,
          orders_count: Number(existing.orders_count || 0) + 1,
          lifetime_value: Number(existing.lifetime_value) + orderTotal,
          last_order_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    } else {
      // Create new customer
      await this.supabase.from("store_customers").insert([
        {
          store_id: storeId,
          name: customer.name,
          email: customer.email,
          phone: customer.phone,
          address: customer.address,
          orders_count: 1,
          lifetime_value: orderTotal,
          currency: "NGN",
          first_order_at: new Date().toISOString(),
          last_order_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
        },
      ]);
    }
  }

  /**
   * Get store customers with pagination
   */
  async getStoreCustomers(
    storeId: string,
    params: {
      page: number;
      limit: number;
      search?: string;
    },
  ): Promise<{
    data: StoreCustomer[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const { page, limit, search } = params;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("store_customers")
      .select("*", { count: "exact" })
      .eq("store_id", storeId)
      .range(offset, offset + limit - 1)
      .order("last_order_at", { ascending: false });

    if (search) {
      query = query.or(`name.ilike.%${search}%,email.ilike.%${search}%`);
    }

    const { data, error, count } = await query;

    if (error) throw error;

    return {
      data: (data as StoreCustomer[]) || [],
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
    };
  }

  // ============================================================================
  // Checkout
  // ============================================================================

  /**
   * Initialize checkout and create Paystack payment link
   */
  private async loadItemValidations(items: CheckoutItemInput[]): Promise<
    Array<{
      item: CheckoutItemInput;
      product: { id: string; type: string; name: string };
    }>
  > {
    const validations = [];
    for (const item of items) {
      const { data: product } = await this.supabase
        .from("products")
        .select("id, type, name")
        .eq("id", item.product_id)
        .single();

      if (!product) throw new Error(`Product not found: ${item.product_id}`);
      validations.push({ item, product });
    }
    return validations;
  }

  private async assertServiceSlotsAvailable(
    validations: Array<{
      item: CheckoutItemInput;
      product: { type: string; name: string };
    }>,
  ): Promise<void> {
    const availabilityService = new AvailabilityService(this.supabase);
    for (const { item, product } of validations) {
      if (product.type !== "service") continue;

      if (!item.slot) {
        throw Object.assign(
          new Error(`Product ${product.name} requires a booking slot`),
          { statusCode: 400 },
        );
      }
      const slotStatus = await availabilityService.validateSlotAvailability(
        item.product_id,
        item.slot,
      );
      if (!slotStatus.isAvailable) {
        throw Object.assign(
          new Error(
            `Selected slot for ${product.name} is unavailable: ${slotStatus.reason}`,
          ),
          { statusCode: 409 },
        );
      }
    }
  }

  async initiateCheckout(data: CheckoutInput): Promise<{
    authorization_url: string;
    reference: string;
    amount: number;
    platform_fee: number;
    gateway_fee: number;
    total_charged: number;
  }> {
    const itemValidations = await this.loadItemValidations(data.items);
    await this.assertServiceSlotsAvailable(itemValidations);

    const charge = await this.resolveStoreCharge(data);
    const result = await charge.provider.initializePayment({
      amount: charge.totalToCharge,
      email: data.customer.email,
      currency: charge.storeCurrency,
      reference: charge.reference,
      callbackUrl: data.callback_url,
      subaccountCode: charge.subaccountCode,
      bearer: charge.feeBearer,
      transactionCharge: Math.round(charge.platformFee * 100),
      flwSubaccountId: charge.flwSubaccountId,
      flwMerchantAmount: charge.flwMerchantAmount,
      metadata: charge.metadata,
    });
    console.log(
      `[StoreService] Payment initialization successful: ${result.reference}`,
    );

    return {
      authorization_url: result.authorization_url,
      reference: result.reference,
      amount: charge.totalToCharge,
      platform_fee: charge.platformFee,
      gateway_fee: charge.gatewayFee,
      total_charged: charge.totalToCharge,
    };
  }

  /**
   * Validates and prices every line in a cart — branch price overrides,
   * variant adjustments, stock, lead time, and server-resolved modifiers.
   * Never trusts a client-sent price. Shared by online checkout
   * (resolveStoreCharge) and POS orders (createPosOrder) so both price a
   * cart identically instead of two divergent implementations.
   */
  private async resolveOrderItemPricing(
    storeId: string,
    items: CheckoutItemInput[],
    branchId?: string,
  ): Promise<{ items: ResolvedOrderItem[]; products: any[] }> {
    // Fetch product details
    const productIds = items.map((i) => i.product_id);
    const { data: products, error: productsError } = await this.supabase
      .from("products")
      .select(
        "id, name, price, currency_prices, stock, status, type, donation, bundle, allow_custom_price, lead_time_hours, min_order_quantity, max_order_quantity, quantity_step",
      )
      .in("id", productIds)
      .eq("status", "published")
      .eq("is_sellable", true);

    if (productsError) throw productsError;
    if (!products || products.length !== productIds.length) {
      throw Object.assign(
        new Error("One or more products not found or not published"),
        { statusCode: 404 },
      );
    }

    // Per-branch price/lead-time overrides — batch-fetched once for the
    // whole checkout, not per item, to avoid N+1. Fetched before the
    // lead-time check below so a branch-scoped lead_time_hours override
    // (e.g. a smaller kitchen needing more notice) can take precedence
    // over the product's own value.
    let branchOverrideByProduct = new Map<
      string,
      { price: number | null; lead_time_hours: number | null }
    >();
    if (branchId) {
      const { data: overrides } = await this.supabase
        .from("branch_catalog_overrides")
        .select("product_id, is_available, price, lead_time_hours")
        .eq("branch_id", branchId)
        .in("product_id", productIds);
      for (const o of overrides || []) {
        if (o.is_available === false) {
          const p = products.find((pr) => pr.id === o.product_id);
          throw Object.assign(
            new Error(
              `${p?.name || "This item"} is not available at this branch`,
            ),
            { statusCode: 400 },
          );
        }
        branchOverrideByProduct.set(o.product_id, {
          price: o.price,
          lead_time_hours: o.lead_time_hours,
        });
      }
    }

    for (const item of items) {
      const product = products.find((p) => p.id === item.product_id);
      if (!product) continue;
      const effectiveLeadTime =
        branchOverrideByProduct.get(item.product_id)?.lead_time_hours ??
        product.lead_time_hours;
      if (effectiveLeadTime) {
        await this.assertLeadTimeMetCached(
          storeId,
          product.name,
          product.id,
          item.variant_id ?? null,
          branchId ?? null,
          effectiveLeadTime,
          item.slot,
        );
      }
      this.assertQuantityConstraints(product.name, item.quantity, product);
    }

    // Fetch variants if any items have variant_id
    const variantIds = items
      .filter((i) => i.variant_id)
      .map((i) => i.variant_id!);

    let variants: any[] = [];
    if (variantIds.length > 0) {
      const { data: variantData } = await supabaseAdmin
        .from("product_variants")
        .select(
          "id, product_id, name, options, price_adjustment, stock, is_active",
        )
        .in("id", variantIds)
        .eq("is_active", true);
      variants = variantData || [];
    }

    // Validate stock and build items with prices
    const itemsWithPrices = await Promise.all(
      items.map(async (item) => {
        const product = products.find((p) => p.id === item.product_id);
        if (!product) {
          throw Object.assign(
            new Error(`Product ${item.product_id} not found`),
            {
              statusCode: 404,
            },
          );
        }

        const branchOverride = branchOverrideByProduct.get(item.product_id);
        const effectiveBasePrice =
          branchOverride?.price != null ? branchOverride.price : product.price;

        const buyerSetsPrice = this.buyerSetsPrice(product);
        let finalPrice = buyerSetsPrice
          ? this.resolveBuyerSetPrice(product, item.price)
          : await this.resolveBundlePrice(product, effectiveBasePrice);

        const isCustomPrice = buyerSetsPrice && product.type !== "donation";
        if (
          isCustomPrice &&
          finalPrice > 0 &&
          finalPrice < CUSTOM_PRICE_PAID_MINIMUM
        ) {
          throw Object.assign(
            new Error(
              `Minimum payment for ${product.name} is ${CUSTOM_PRICE_PAID_MINIMUM}`,
            ),
            { statusCode: 400 },
          );
        }

        let variantName: string | null = null;
        let variantPriceAdjustment = 0;
        let variantOptions: Array<{ name: string; value: string }> = [];

        // Handle variant if specified
        if (item.variant_id) {
          const variant = variants.find((v) => v.id === item.variant_id);
          if (!variant) {
            throw Object.assign(
              new Error(`Variant ${item.variant_id} not found or not active`),
              { statusCode: 404 },
            );
          }
          if (variant.product_id !== item.product_id) {
            throw Object.assign(
              new Error(
                `Variant ${item.variant_id} does not belong to product ${item.product_id}`,
              ),
              { statusCode: 400 },
            );
          }

          // Apply variant price adjustment (skipped when the buyer set the price)
          if (!buyerSetsPrice) {
            finalPrice += variant.price_adjustment;
          }
          variantName = variant.name;
          variantPriceAdjustment = variant.price_adjustment;
          variantOptions = Array.isArray(variant.options) ? variant.options : [];

          // Check variant stock
          if (variant.stock !== null && variant.stock < item.quantity) {
            throw Object.assign(
              new Error(`Insufficient stock for variant: ${variant.name}`),
              { statusCode: 409 },
            );
          }
        } else {
          // Check product stock (no variant)
          if (
            !buyerSetsPrice &&
            product.stock !== null &&
            product.stock < item.quantity
          ) {
            throw Object.assign(
              new Error(`Insufficient stock for ${product.name}`),
              { statusCode: 409 },
            );
          }
        }

        // Validate bundled product stock at checkout time
        if (product.type === "bundle" && product.bundle?.product_ids?.length) {
          await this.validateBundledProductStock(
            product.bundle.product_ids,
            item.quantity,
          );
        }

        // Modifiers/add-ons (food stores) — server-resolved, never trust
        // client-sent price deltas. Skipped when the buyer set the price.
        const { priceDelta: modifierPriceDelta, resolved: selectedModifiers } =
          !buyerSetsPrice
            ? await this.resolveSelectedModifiers(
                item.product_id,
                item.selected_modifiers,
                branchId,
              )
            : { priceDelta: 0, resolved: [] };
        finalPrice += modifierPriceDelta;

        return {
          product_id: item.product_id,
          product_name: product.name,
          variant_id: item.variant_id || null,
          variant_name: variantName,
          variant_price_adjustment: variantPriceAdjustment,
          variant_options: variantOptions,
          quantity: item.quantity,
          price: finalPrice,
          slot: item.slot || null,
          selected_modifiers: selectedModifiers,
          note: item.note || null,
        };
      }),
    );

    return { items: itemsWithPrices, products };
  }

  /**
   * Subtotal → discount → tax → service charge → total — the one place
   * this formula is computed, shared by online checkout and POS orders.
   * `deliveryFee` is a pre-resolved input (delivery-zone matching is
   * storefront-only and stays in resolveStoreCharge; POS passes 0).
   */
  private async computeOrderPricing(params: {
    items: ResolvedOrderItem[];
    storeId: string;
    branchId?: string;
    fulfillmentType?: "dine_in" | "pickup" | "delivery" | "curbside";
    discountCode?: string;
    customerEmail?: string;
    deliveryFee: number;
    // Storefront-only (delivery-zone minimum order) — resolved by the
    // caller, checked here so it runs at the exact same point in the
    // sequence the original inline code did (after discount, before tax).
    // N/A for POS.
    minOrder?: { amount: number; message: string };
  }): Promise<OrderPricing> {
    const {
      items,
      storeId,
      branchId,
      fulfillmentType,
      discountCode,
      customerEmail,
      deliveryFee,
      minOrder,
    } = params;

    const subtotal = items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0,
    );

    const discountEvaluation = await this.evaluateDiscounts({
      storeId,
      customerEmail,
      code: discountCode,
      items: items.map((item) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        line_total: item.price * item.quantity,
      })),
    });
    const discount = discountEvaluation.discount_amount;

    if (minOrder && subtotal < minOrder.amount) {
      throw Object.assign(new Error(minOrder.message), { statusCode: 400 });
    }

    const taxRate = branchId ? await this.resolveBranchTaxRate(branchId) : 0;
    const taxAmount = subtotal * (taxRate / 100);

    const serviceChargeRate = branchId
      ? await this.resolveBranchServiceChargeRate(branchId, fulfillmentType)
      : 0;
    const serviceChargeAmount = subtotal * (serviceChargeRate / 100);

    const total =
      subtotal - discount + deliveryFee + taxAmount + serviceChargeAmount;

    return {
      subtotal,
      discount,
      discountDetails: discountEvaluation.discounts,
      deliveryFee,
      taxRate,
      taxAmount,
      serviceChargeRate,
      serviceChargeAmount,
      total,
    };
  }

  /**
   * Validate the cart and resolve pricing, split, and metadata for a store
   * checkout. Shared by the card and bank-transfer entry points so both charge
   * an identical amount with an identical split.
   */
  private async resolveStoreCharge(
    data: CheckoutInput,
  ): Promise<ResolvedStoreCharge> {
    // A scanned QR code always wins over whatever branch/fulfilment the
    // client sent — resolved server-side, never trusted, same principle as
    // modifier prices and branch overrides below.
    let resolvedQr: {
      id: string;
      branch_id: string | null;
      label: string;
    } | null = null;
    if (data.qr_code) {
      resolvedQr = await this.resolveQrCode(data.store_id, data.qr_code);
      data.branch_id = resolvedQr.branch_id ?? data.branch_id;
      data.fulfillment_type = "dine_in";
    }

    if (data.branch_id) {
      await this.assertBranchAcceptingOrders(data.branch_id);
    }

    // Price every line (branch overrides, variants, modifiers, stock,
    // lead-time/quantity guards) — shared with POS via resolveOrderItemPricing.
    const { items: itemsWithPrices, products } =
      await this.resolveOrderItemPricing(
        data.store_id,
        data.items,
        data.branch_id,
      );

    // Calculate delivery fee — a matched delivery zone (branch + customer
    // zip) takes priority, then the merchant's flat-rate delivery method,
    // then whatever fee the client itself quoted (e.g. a live courier rate).
    let deliveryFee = 0;
    let deliveryMethodName: string | undefined;
    let matchedZone: {
      fee: number;
      min_order: number | null;
      estimated_minutes: number | null;
    } | null = null;

    if (data.branch_id && data.delivery_zip) {
      matchedZone = await this.matchDeliveryZone(
        data.store_id,
        data.branch_id,
        data.delivery_zip,
      );
    }

    if (matchedZone) {
      deliveryFee = matchedZone.fee / 100; // Convert Kobo to Naira
      deliveryMethodName = "Zone delivery";
    } else if (data.delivery_method_id) {
      const method = await this.validateDeliveryMethod(
        data.store_id,
        data.delivery_method_id,
      );
      if (method) {
        deliveryFee = method.price / 100; // Convert Kobo to Naira
        deliveryMethodName = method.name;
      }
    } else if (data.delivery_fee) {
      deliveryFee = data.delivery_fee / 100; // Assume input is Kobo (from frontend selection)
    }

    // Discount → zone min-order gate → tax → service charge → total —
    // shared with POS via computeOrderPricing (same formula, same order
    // of operations as the original inline code).
    const {
      subtotal,
      discount,
      discountDetails,
      taxAmount,
      serviceChargeAmount,
      total,
    } = await this.computeOrderPricing({
        items: itemsWithPrices,
        storeId: data.store_id,
        branchId: data.branch_id,
        fulfillmentType: data.fulfillment_type,
        discountCode: data.discount_code,
        customerEmail: data.customer.email,
        deliveryFee,
        minOrder:
          matchedZone?.min_order != null
            ? {
                amount: matchedZone.min_order / 100,
                message: `This delivery zone requires a minimum order of ${matchedZone.min_order / 100}`,
              }
            : undefined,
      });

    // Use provided reference or let Paystack generate one
    const reference = data.payment_reference || undefined;

    // Fetch store with business subaccount info for split payment
    // Subaccount priority: store-level override → business-level
    const { data: store } = await this.supabase
      .from("stores")
      .select(
        `
        user_id, name, business_id,
        paystack_subaccount_code,
        business:businesses(
          paystack_subaccount_code,
          paystack_fee_bearer,
          flw_subaccount_id
        )
      `,
      )
      .eq("id", data.store_id)
      .single();

    // Resolve subaccount with priority: store → business → owner
    let subaccountCode: string | undefined =
      store?.paystack_subaccount_code ||
      (store?.business as any)?.paystack_subaccount_code;

    // Fee bearer is configured only at the business level (default: subaccount pays)
    const feeBearer = ((store?.business as any)?.paystack_fee_bearer ||
      "subaccount") as FeeBearer;

    const flwSubaccountId: string | undefined =
      (store?.business as any)?.flw_subaccount_id ?? undefined;

    // Initialize payment via factory (NGN → Paystack, other currencies → Flutterwave)
    // data.currency (from frontend selector) takes precedence over the store-level default
    const storeCurrency = (data.currency ||
      (store as any).payment_currency ||
      "NGN") as SupportedCurrency;

    if (storeCurrency !== "NGN" && !flwSubaccountId) {
      throw Object.assign(
        new Error("This store has not set up multi-currency payments yet."),
        { statusCode: 422 },
      );
    }

    // Resolve the charge in the buyer's currency, honouring any explicit
    // per-currency product prices and FX-converting everything else.
    const pricingSnapshot = await this.buildCheckoutPricingSnapshot({
      items: itemsWithPrices,
      products,
      subtotalNGN: subtotal,
      discountNGN: discount,
      deliveryFeeNGN: deliveryFee,
      taxAmountNGN: taxAmount,
      serviceChargeAmountNGN: serviceChargeAmount,
      targetCurrency: storeCurrency,
    });
    const convertedTotal = pricingSnapshot.pre_provider_fee_total;
    const convertedDeliveryFee = pricingSnapshot.delivery.converted_amount;

    // The gateway estimate must come from the provider that actually
    // processes the charge; resolveCustomerCharge applies the bearer mode.
    const chargeContext: ChargeContext = {
      provider: resolvePaymentProvider(storeCurrency),
      currency: storeCurrency,
    };
    const { totalToCharge, platformFee, gatewayFee } = resolveCustomerCharge(
      convertedTotal,
      feeBearer,
      chargeContext,
    );
    const flwMerchantAmount = deriveFlutterwaveMerchantShare({
      feeBearer,
      baseAmount: convertedTotal,
      totalToCharge,
      platformFee,
      gatewayFee,
    });
    pricingSnapshot.platform_fee = platformFee;
    pricingSnapshot.provider_fee = gatewayFee;
    pricingSnapshot.amount_sent_to_provider = totalToCharge;
    const storeProvider = PaymentProviderFactory.getProvider(storeCurrency);
    const metadata: PaymentMetadata = {
      store_id: data.store_id,
      business_id: store?.business_id ?? undefined,
      customer_name: data.customer.name,
      customer_email: data.customer.email,
      customer_phone: data.customer.phone,
      customer_address: data.customer.address,
      items: itemsWithPrices,
      discount_code: data.discount_code,
      discount_details: discountDetails,
      transaction_type: "store_purchase",
      items_total: total,
      converted_items_total: convertedTotal,
      converted_subtotal: pricingSnapshot.subtotal,
      converted_discount: pricingSnapshot.discount,
      pricing_snapshot: pricingSnapshot,
      platform_fee: platformFee,
      // Legacy key kept in lockstep so pre-upgrade verification paths and
      // in-flight pending checkouts keep resolving the estimate.
      gateway_fee_estimate: gatewayFee,
      paystack_fee_estimate: gatewayFee,
      fee_bearer: feeBearer,
      delivery_method_id: data.delivery_method_id,
      delivery_fee: deliveryFee,
      converted_delivery_fee: convertedDeliveryFee,
      delivery_name: deliveryMethodName,
      delivery_provider: data.delivery_provider,
      delivery_service_code: data.delivery_service_code,
      delivery_courier_id: data.delivery_courier_id,
      delivery_city: data.delivery_city,
      delivery_state: data.delivery_state,
      currency: storeCurrency,
      payment_provider: resolvePaymentProvider(storeCurrency),
      flw_subaccount_id: flwSubaccountId,
      fulfillment_type: data.fulfillment_type,
      branch_id: data.branch_id,
      utensils_requested: data.utensils_requested,
      tax_amount: taxAmount,
      service_charge_amount: serviceChargeAmount,
      notes: data.notes,
      qr_code_id: resolvedQr?.id,
      location_label: resolvedQr?.label,
    };

    return {
      provider: storeProvider,
      storeCurrency,
      reference,
      subaccountCode,
      feeBearer,
      flwSubaccountId,
      convertedTotal,
      totalToCharge,
      platformFee,
      gatewayFee,
      flwMerchantAmount,
      metadata,
    };
  }

  /**
   * Issue a transaction-scoped virtual account for a bank-transfer checkout.
   *
   * Shares {@link resolveStoreCharge} with the card flow, so the buyer pays the
   * same total and the merchant receives the same split. The order itself is
   * created later by the charge.success webhook once the transfer lands — the
   * same path the card flow already uses — so no order is written here.
   */
  async initiateBankTransferCheckout(data: CheckoutInput): Promise<{
    reference: string;
    amount: number;
    platform_fee: number;
    virtual_account: VirtualAccount;
  }> {
    const itemValidations = await this.loadItemValidations(data.items);
    await this.assertServiceSlotsAvailable(itemValidations);

    const hasMembership = itemValidations.some(
      (validation) => validation.product.type === "membership",
    );
    if (hasMembership) {
      throw Object.assign(new Error("Memberships must be paid for by card."), {
        statusCode: 400,
      });
    }

    const charge = await this.resolveStoreCharge(data);

    if (charge.storeCurrency !== "NGN") {
      throw Object.assign(
        new Error("Bank transfer is only available for Naira payments."),
        { statusCode: 422 },
      );
    }
    if (!charge.provider.initiateBankTransfer) {
      throw Object.assign(
        new Error("Bank transfer is not supported for this store."),
        { statusCode: 422 },
      );
    }

    const { reference, virtualAccount } =
      await charge.provider.initiateBankTransfer({
        amount: charge.totalToCharge,
        email: data.customer.email,
        reference: charge.reference,
        subaccountCode: charge.subaccountCode,
        bearer: charge.feeBearer,
        transactionCharge: Math.round(charge.platformFee * 100),
        metadata: charge.metadata,
      });

    return {
      reference,
      amount: charge.totalToCharge,
      platform_fee: charge.platformFee,
      virtual_account: virtualAccount,
    };
  }

  /**
   * Report whether the order behind a checkout reference has been paid.
   *
   * A bank-transfer buyer polls this while their transfer clears. The order row
   * is written by the charge.success webhook, so a row with a settled status is
   * the signal that payment landed; its absence means we are still waiting.
   */
  async getCheckoutStatus(reference: string): Promise<{
    status: "paid" | "pending";
    order_id?: string;
    order_number?: string;
  }> {
    const settledStatuses = ["paid", "fulfilled", "pre_order"];
    const { data: order } = await this.supabase
      .from("store_orders")
      .select("id, order_number, status")
      .eq("payment_reference", reference)
      .maybeSingle();

    if (order && settledStatuses.includes(order.status)) {
      return {
        status: "paid",
        order_id: order.id,
        order_number: order.order_number,
      };
    }
    return { status: "pending" };
  }

  /**
   * Build the immutable buyer-currency breakdown used by fulfillment, recovery,
   * receipts, and merchant/customer emails. Explicit product currency prices
   * are distinguished from FX-converted values; every actual conversion keeps
   * the exact cached rate evidence used at checkout time.
   */
  private async buildCheckoutPricingSnapshot(params: {
    items: ResolvedOrderItem[];
    products: Array<{
      id: string;
      price: number;
      currency_prices?: CurrencyPriceMap | null;
    }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN: number;
    serviceChargeAmountNGN: number;
    targetCurrency: SupportedCurrency;
  }): Promise<CheckoutPricingSnapshot> {
    const toFxEvidence = (
      conversion: PaymentConversion,
    ): CheckoutFxEvidence => ({
      source: conversion.source,
      rate: conversion.rate,
      rate_timestamp: conversion.rateTimestamp,
      source_currency: "NGN",
      target_currency: params.targetCurrency,
    });

    const convertComponent = async (amountNGN: number) => {
      if (amountNGN === 0) {
        return {
          original_amount_ngn: 0,
          converted_amount: 0,
          fx: undefined,
        };
      }
      const conversion = await resolvePaymentConversion(
        amountNGN,
        params.targetCurrency,
      );
      return {
        original_amount_ngn: amountNGN,
        converted_amount: conversion.amount,
        fx: toFxEvidence(conversion),
      };
    };

    const items = await Promise.all(
      params.items.map(async (item) => {
        const product = params.products.find(
          (candidate) => candidate.id === item.product_id,
        );
        const baseUnitNGN = item.price - item.variant_price_adjustment;
        const explicitPrice = getCurrencyOverride(
          product?.currency_prices,
          params.targetCurrency,
        );
        const baseConversion = explicitPrice
          ? null
          : await resolvePaymentConversion(baseUnitNGN, params.targetCurrency);
        const convertedBaseUnit =
          explicitPrice?.price ?? baseConversion!.amount;
        const variantConversion =
          item.variant_price_adjustment === 0
            ? null
            : await resolvePaymentConversion(
                item.variant_price_adjustment,
                params.targetCurrency,
              );
        const convertedUnitPrice = Number(
          (convertedBaseUnit + (variantConversion?.amount ?? 0)).toFixed(2),
        );

        return {
          product_id: item.product_id,
          product_name: item.product_name,
          variant_id: item.variant_id,
          variant_name: item.variant_name,
          quantity: item.quantity,
          base_unit_price_ngn: baseUnitNGN,
          base_variant_adjustment_ngn: item.variant_price_adjustment,
          converted_unit_price: convertedUnitPrice,
          converted_variant_adjustment: variantConversion?.amount ?? 0,
          converted_line_total: Number(
            (convertedUnitPrice * item.quantity).toFixed(2),
          ),
          pricing_source: explicitPrice
            ? ("explicit_currency_price" as const)
            : params.targetCurrency === "NGN"
              ? ("base_currency" as const)
              : ("fx_conversion" as const),
          base_price_fx: baseConversion
            ? toFxEvidence(baseConversion)
            : undefined,
          variant_fx: variantConversion
            ? toFxEvidence(variantConversion)
            : undefined,
        };
      }),
    );

    const subtotal = Number(
      items
        .reduce((sum, item) => sum + item.converted_line_total, 0)
        .toFixed(2),
    );
    const discount = Number(
      (params.subtotalNGN > 0
        ? params.discountNGN * (subtotal / params.subtotalNGN)
        : 0
      ).toFixed(2),
    );
    const [delivery, tax, serviceCharge] = await Promise.all([
      convertComponent(params.deliveryFeeNGN),
      convertComponent(params.taxAmountNGN),
      convertComponent(params.serviceChargeAmountNGN),
    ]);
    const preProviderFeeTotal = Number(
      (
        subtotal -
        discount +
        delivery.converted_amount +
        tax.converted_amount +
        serviceCharge.converted_amount
      ).toFixed(2),
    );

    return {
      version: 1,
      currency: params.targetCurrency,
      created_at: new Date().toISOString(),
      items,
      subtotal,
      discount,
      delivery,
      tax,
      service_charge: serviceCharge,
      pre_provider_fee_total: preProviderFeeTotal,
      platform_fee: 0,
      provider_fee: 0,
      amount_sent_to_provider: preProviderFeeTotal,
    };
  }

  private async buildLegacyRecoveryPricingSnapshot(params: {
    items: Array<{
      product_id: string;
      product_name?: string;
      variant_id?: string | null;
      variant_name?: string | null;
      variant_price_adjustment?: number;
      quantity: number;
      price: number;
      slot?: { startTime: string; endTime: string; date: string } | null;
      selected_modifiers?: unknown[];
      note?: string | null;
    }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN: number;
    serviceChargeAmountNGN: number;
    targetCurrency: SupportedCurrency;
  }): Promise<CheckoutPricingSnapshot> {
    const productIds = params.items.map((item) => item.product_id);
    const { data: products, error } = await this.supabase
      .from("products")
      .select("id, name, price, currency_prices")
      .in("id", productIds);
    if (error) throw error;

    return this.buildCheckoutPricingSnapshot({
      ...params,
      items: params.items.map((item) => ({
        product_id: item.product_id,
        product_name:
          item.product_name ??
          products?.find((product) => product.id === item.product_id)?.name ??
          "Item",
        variant_id: item.variant_id ?? null,
        variant_name: item.variant_name ?? null,
        variant_price_adjustment: Number(item.variant_price_adjustment) || 0,
        // This recovery path rebuilds a snapshot from older, incomplete
        // metadata that predates variant_options — nothing to recover here.
        variant_options: [],
        quantity: item.quantity,
        price: Number(item.price),
        slot: item.slot ?? null,
        selected_modifiers: item.selected_modifiers ?? [],
        note: item.note ?? null,
      })),
      products: products ?? [],
    });
  }

  /**
   * Resolve the pre-fee order total in the buyer's currency.
   *
   * Each line item uses the seller's explicit per-currency price when one exists,
   * otherwise FX-converts the NGN base. Variant adjustments and delivery always
   * FX-convert from NGN; the discount is scaled by the subtotal ratio so it stays
   * proportional in the target currency. For NGN this returns the NGN total
   * unchanged.
   */
  private async resolveConvertedItemsTotal(params: {
    items: Array<{
      product_id: string;
      price: number;
      quantity: number;
      variant_price_adjustment: number;
    }>;
    products: Array<{
      id: string;
      price: number;
      currency_prices?: CurrencyPriceMap | null;
    }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN?: number;
    targetCurrency: SupportedCurrency;
  }): Promise<number> {
    return (await this.resolveConvertedOrderPricing(params)).total;
  }

  private async resolveConvertedOrderPricing(params: {
    items: Array<{
      product_id: string;
      price: number;
      quantity: number;
      variant_price_adjustment: number;
    }>;
    products: Array<{
      id: string;
      price: number;
      currency_prices?: CurrencyPriceMap | null;
    }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN?: number;
    targetCurrency: SupportedCurrency;
  }): Promise<{
    subtotal: number;
    discount: number;
    deliveryFee: number;
    tax: number;
    total: number;
  }> {
    const {
      items,
      products,
      subtotalNGN,
      discountNGN,
      deliveryFeeNGN,
      taxAmountNGN = 0,
      targetCurrency,
    } = params;

    let subtotalTarget = 0;
    for (const item of items) {
      const product = products.find(
        (candidate) => candidate.id === item.product_id,
      );
      const baseNGN = item.price - item.variant_price_adjustment;
      const baseTarget = await resolveUnitPrice(
        baseNGN,
        product?.currency_prices,
        targetCurrency,
      );
      const adjustmentTarget = await resolvePaymentAmount(
        item.variant_price_adjustment,
        targetCurrency,
      );
      subtotalTarget += (baseTarget + adjustmentTarget) * item.quantity;
    }

    const deliveryFeeTarget = await resolvePaymentAmount(
      deliveryFeeNGN,
      targetCurrency,
    );
    const taxTarget = await resolvePaymentAmount(taxAmountNGN, targetCurrency);
    const discountTarget =
      subtotalNGN > 0 ? discountNGN * (subtotalTarget / subtotalNGN) : 0;

    return {
      subtotal: Number(subtotalTarget.toFixed(2)),
      discount: Number(discountTarget.toFixed(2)),
      deliveryFee: Number(deliveryFeeTarget.toFixed(2)),
      tax: Number(taxTarget.toFixed(2)),
      total: Number(
        (
          subtotalTarget -
          discountTarget +
          deliveryFeeTarget +
          taxTarget
        ).toFixed(2),
      ),
    };
  }

  /**
   * Rebuild a legacy non-NGN checkout total from current product pricing.
   * Explicit seller-configured currency prices win; products without an
   * override use the existing FX conversion fallback.
   */
  private async resolveLegacyRecoveryConvertedTotal(params: {
    items: Array<{ product_id: string; price: number; quantity: number }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN: number;
    targetCurrency: SupportedCurrency;
  }): Promise<number> {
    return (await this.resolveLegacyRecoveryConvertedPricing(params)).total;
  }

  private async resolveLegacyRecoveryConvertedPricing(params: {
    items: Array<{ product_id: string; price: number; quantity: number }>;
    subtotalNGN: number;
    discountNGN: number;
    deliveryFeeNGN: number;
    taxAmountNGN: number;
    targetCurrency: SupportedCurrency;
  }): Promise<{
    subtotal: number;
    discount: number;
    deliveryFee: number;
    tax: number;
    total: number;
  }> {
    const productIds = params.items.map((item) => item.product_id);
    const { data: products, error } = await this.supabase
      .from("products")
      .select("id, price, currency_prices")
      .in("id", productIds);
    if (error) throw error;

    return this.resolveConvertedOrderPricing({
      items: params.items.map((item) => ({
        ...item,
        price: Number(item.price),
        variant_price_adjustment: 0,
      })),
      products: products ?? [],
      subtotalNGN: params.subtotalNGN,
      discountNGN: params.discountNGN,
      deliveryFeeNGN: params.deliveryFeeNGN,
      taxAmountNGN: params.taxAmountNGN,
      targetCurrency: params.targetCurrency,
    });
  }

  // ============================================================================
  // Category Management
  // ============================================================================

  /**
   * Get all categories for a store with product counts
   */
  async getCategories(
    storeId: string,
    menuId?: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      description: string | null;
      position: number;
      is_active: boolean;
      product_count: number;
      created_at: string;
      updated_at: string;
      parent_id: string | null;
    }>
  > {
    let query = this.supabase
      .from("store_categories")
      .select("*, product_categories(count)")
      .eq("store_id", storeId)
      .neq("is_menu", true);

    if (menuId) {
      query = query.eq("parent_id", menuId);
    }

    const { data: categories, error } = await query
      .order("position", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) throw error;

    return (categories || []).map((cat: any) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      description: cat.description,
      position: cat.position,
      is_active: cat.is_active,
      product_count: cat.product_categories?.[0]?.count || 0,
      created_at: cat.created_at,
      updated_at: cat.updated_at,
      parent_id: cat.parent_id ?? null,
    }));
  }

  /**
   * Create a new category
   */
  async createCategory(
    storeId: string,
    data: {
      name: string;
      description?: string;
      is_active?: boolean;
      position?: number;
      parent_id?: string | null;
    },
  ): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    position: number;
    is_active: boolean;
    created_at: string;
    parent_id: string | null;
  }> {
    // Generate slug from name
    const slug = data.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");

    // Check if name or slug already exists
    const { data: existing } = await this.supabase
      .from("store_categories")
      .select("id, name, slug")
      .eq("store_id", storeId)
      .or(`name.ilike.${data.name},slug.eq.${slug}`)
      .limit(1);

    if (existing && existing.length > 0) {
      throw Object.assign(new Error("Category name already exists"), {
        statusCode: 409,
      });
    }

    // Get max position if not provided
    let position = data.position;
    if (position === undefined) {
      const { data: maxPos } = await this.supabase
        .from("store_categories")
        .select("position")
        .eq("store_id", storeId)
        .order("position", { ascending: false })
        .limit(1)
        .single();
      position = (maxPos?.position || 0) + 1;
    }

    const { data: category, error } = await this.supabase
      .from("store_categories")
      .insert([
        {
          store_id: storeId,
          name: data.name,
          slug,
          description: data.description || null,
          position,
          is_active: data.is_active !== false,
          parent_id: data.parent_id ?? null,
        },
      ])
      .select("*")
      .single();

    if (error) throw error;
    return category;
  }

  /**
   * Update a category
   */
  async updateCategory(
    storeId: string,
    categoryId: string,
    updates: {
      name?: string;
      description?: string;
      is_active?: boolean;
      position?: number;
      parent_id?: string | null;
    },
  ): Promise<{
    id: string;
    name: string;
    slug: string;
    description: string | null;
    position: number;
    is_active: boolean;
    parent_id: string | null;
  }> {
    // Verify category belongs to store
    const { data: existing, error: existingError } = await this.supabase
      .from("store_categories")
      .select("*")
      .eq("id", categoryId)
      .eq("store_id", storeId)
      .single();

    if (existingError || !existing) {
      throw Object.assign(new Error("Category not found"), { statusCode: 404 });
    }

    const updateData: any = { updated_at: new Date().toISOString() };

    if (updates.name && updates.name !== existing.name) {
      // Check uniqueness
      const { data: duplicate } = await this.supabase
        .from("store_categories")
        .select("id")
        .eq("store_id", storeId)
        .ilike("name", updates.name)
        .neq("id", categoryId)
        .limit(1);

      if (duplicate && duplicate.length > 0) {
        throw Object.assign(new Error("Category name already exists"), {
          statusCode: 409,
        });
      }

      updateData.name = updates.name;
      updateData.slug = updates.name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-");
    }

    if (updates.description !== undefined)
      updateData.description = updates.description;
    if (updates.is_active !== undefined)
      updateData.is_active = updates.is_active;
    if (updates.position !== undefined) updateData.position = updates.position;
    if (updates.parent_id !== undefined)
      updateData.parent_id = updates.parent_id;

    const { data: category, error } = await this.supabase
      .from("store_categories")
      .update(updateData)
      .eq("id", categoryId)
      .select("*")
      .single();

    if (error) throw error;
    return category;
  }

  /**
   * Delete a category (products remain, just lose category association)
   */
  async deleteCategory(storeId: string, categoryId: string): Promise<void> {
    // Verify category belongs to store
    const { data: existing } = await this.supabase
      .from("store_categories")
      .select("id")
      .eq("id", categoryId)
      .eq("store_id", storeId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Category not found"), { statusCode: 404 });
    }

    // Delete category (product_categories entries cascade automatically)
    const { error } = await this.supabase
      .from("store_categories")
      .delete()
      .eq("id", categoryId);

    if (error) throw error;
  }

  /**
   * Bulk reorder categories
   */
  async reorderCategories(
    storeId: string,
    order: Array<{ id: string; position: number }>,
  ): Promise<void> {
    // Verify all categories belong to store
    const categoryIds = order.map((o) => o.id);
    const { data: existing } = await this.supabase
      .from("store_categories")
      .select("id")
      .eq("store_id", storeId)
      .in("id", categoryIds);

    if (!existing || existing.length !== categoryIds.length) {
      throw Object.assign(new Error("One or more categories not found"), {
        statusCode: 404,
      });
    }

    // Update positions
    for (const item of order) {
      await this.supabase
        .from("store_categories")
        .update({
          position: item.position,
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id);
    }
  }

  /**
   * Assign categories to a product (replaces existing)
   */
  async assignProductCategories(
    storeId: string,
    productId: string,
    categoryIds: string[],
  ): Promise<void> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // If categoryIds provided, verify they all belong to same store
    if (categoryIds && categoryIds.length > 0) {
      const { data: categories } = await this.supabase
        .from("store_categories")
        .select("id")
        .eq("store_id", storeId)
        .in("id", categoryIds);

      if (!categories || categories.length !== categoryIds.length) {
        throw Object.assign(new Error("One or more categories not found"), {
          statusCode: 404,
        });
      }
    }

    // Delete existing assignments
    await this.supabase
      .from("product_categories")
      .delete()
      .eq("product_id", productId);

    // Insert new assignments
    if (categoryIds && categoryIds.length > 0) {
      const assignments = categoryIds.map((catId) => ({
        product_id: productId,
        category_id: catId,
      }));

      const { error } = await this.supabase
        .from("product_categories")
        .insert(assignments);

      if (error) throw error;
    }
  }

  /**
   * Get product categories
   */
  async getProductCategories(
    productId: string,
  ): Promise<
    Array<{ id: string; name: string; slug: string; parent_id: string | null }>
  > {
    const { data, error } = await this.supabase
      .from("product_categories")
      .select(
        `
        category:store_categories(id, name, slug, parent_id)
      `,
      )
      .eq("product_id", productId);

    if (error) throw error;
    return data.map((item: any) => item.category);
  }

  // ============================================================================
  // Inventory Management
  // ============================================================================

  /**
   * Paginated stock-movement ledger. `page`/`pageSize` bound the result set
   * and a total count is returned so the History/Adjustments tabs can drive
   * server-side pagination; `excludeReasons` narrows a page to one view
   * (e.g. the Adjustments tab hides sale/restock/return rows). `created_by`
   * is resolved to a display name via a left join, so the UI can show who
   * made each change. When no paging options are supplied the first 50 rows
   * are returned, preserving legacy callers.
   */
  async getStockMovements(
    storeId: string,
    options: {
      page?: number;
      pageSize?: number;
      productId?: string;
      excludeReasons?: string[];
    } = {},
  ): Promise<{ movements: any[]; total: number }> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    let countQuery = this.supabase
      .from("stock_movements")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId);
    let dataQuery = this.supabase
      .from("stock_movements")
      .select(
        `
        id, product_id, variant_id, quantity_change, reason, reference_id, created_at, created_by, effective_at,
        product:products(name),
        variant:product_variants(name),
        branch:store_branches(name),
        mover:users(name)
      `,
      )
      .eq("store_id", storeId);

    if (options.productId) {
      countQuery = countQuery.eq("product_id", options.productId);
      dataQuery = dataQuery.eq("product_id", options.productId);
    }
    if (options.excludeReasons?.length) {
      countQuery = countQuery.not("reason", "in", `(${options.excludeReasons.join(",")})`);
      dataQuery = dataQuery.not("reason", "in", `(${options.excludeReasons.join(",")})`);
    }

    const [{ count, error: countError }, { data, error: dataError }] =
      await Promise.all([
        countQuery,
        dataQuery.order("created_at", { ascending: false }).range(from, to),
      ]);

    if (countError) throw countError;
    if (dataError) throw dataError;

    const movements = (data || []).map(({ mover, ...row }) => {
      const user = (mover ?? null) as { name?: string } | null;
      // Flatten the joined user embed into the frontend shape. The generated
      // DB types type `mover` as an array while PostgREST returns a single
      // object, so normalise both shapes.
      const moverName = Array.isArray(user) ? user[0]?.name : user?.name;
      return { ...row, created_by_name: moverName || null };
    });

    return { movements, total: count ?? 0 };
  }

  /** Record a stock movement and adjust the affected product or branch balance. */
  async bulkUpdateStock(
    storeId: string,
    updates: Array<{
      product_id: string;
      variant_id?: string;
      branch_id?: string;
      quantity_change: number;
      reason?:
        | "sale"
        | "return"
        | "restock"
        | "received"
        | "damaged"
        | "spoilage"
        | "expired"
        | "theft"
        | "shrinkage"
        | "found"
        | "count"
        | "transfer_out"
        | "transfer_in"
        | "adjustment";
      unit_cost?: number;
      batch_number?: string | null;
      expiry_date?: string | null;
      effective_at?: string;
      notes?: string;
    }>,
    userId: string,
  ): Promise<void> {
    for (const update of updates) {
      if (!update.product_id) continue;
      const quantity_change = Number(update.quantity_change);
      if (!Number.isFinite(quantity_change)) continue;

      const { data: ownedProduct, error: ownershipError } = await this.supabase
        .from("products")
        .select("id")
        .eq("id", update.product_id)
        .eq("store_id", storeId)
        .maybeSingle();
      if (ownershipError) throw ownershipError;
      if (!ownedProduct) {
        throw Object.assign(
          new Error("Product not found in this store"),
          { statusCode: 404 },
        );
      }

      if (update.branch_id) {
        await this.validateBranchOwnership(
          storeId,
          update.branch_id,
          update.product_id,
          update.variant_id,
        );
      }

      const { error: moveError } = await this.supabase
        .from("stock_movements")
        .insert({
          store_id: storeId,
          product_id: update.product_id,
          variant_id: update.variant_id || null,
          branch_id: update.branch_id || null,
          quantity_change,
          reason: update.reason || "adjustment",
          unit_cost: update.unit_cost ?? null,
          batch_number: update.batch_number ?? null,
          expiry_date: update.expiry_date ?? null,
          effective_at: update.effective_at || null,
          notes: update.notes || null,
          created_by: userId,
        });
      if (moveError) throw moveError;

      if (update.branch_id) {
        await this.adjustBranchStock(
          storeId,
          update.product_id,
          update.variant_id,
          update.branch_id,
          quantity_change,
        );
      } else if (update.variant_id) {
        await this.incrementVariantStock(
          update.product_id,
          update.variant_id,
          quantity_change,
        );
      } else {
        await this.incrementProductStock(
          storeId,
          update.product_id,
          quantity_change,
          update.unit_cost,
        );
      }
    }
  }

  /**
   * Throw unless a branch belongs to a store (used for transfers, where a
   * product isn't known yet at header-creation time).
   */
  private async assertBranchBelongsToStore(
    storeId: string,
    branchId: string,
  ): Promise<void> {
    await this.validateBranchOwnership(storeId, branchId, "");
  }

  /** Throw unless branch exists and owns the given product (and variant). */
  private async validateBranchOwnership(
    storeId: string,
    branchId: string,
    productId: string,
    variantId?: string,
  ): Promise<void> {
    const { data: branch, error } = await this.supabase
      .from("store_branches")
      .select("id")
      .eq("id", branchId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) throw error;
    if (!branch) {
      throw Object.assign(
        new Error("Branch not found in this store"),
        { statusCode: 400 },
      );
    }

    if (variantId) {
      const { data: variant, error: variantError } = await this.supabase
        .from("product_variants")
        .select("id")
        .eq("id", variantId)
        .eq("product_id", productId)
        .maybeSingle();
      if (variantError) throw variantError;
      if (!variant) {
        throw Object.assign(
          new Error("Variant not found for this product"),
          { statusCode: 400 },
        );
      }
    }
  }

  /**
   * Apply a relative +/- change to a branch balance. A missing sparse override
   * is seeded from the current global product/variant stock so the branch
   * "inherits then takes control" rather than starting from nothing.
   */
  private async adjustBranchStock(
    storeId: string,
    productId: string,
    variantId: string | undefined,
    branchId: string,
    quantityChange: number,
  ): Promise<void> {
    const grain = variantId ? variantId : null;

    let branchQuery = this.supabase
      .from("branch_inventory_overrides")
      .select("id, stock_quantity")
      .eq("branch_id", branchId)
      .eq("product_id", productId);
    branchQuery = variantId
      ? branchQuery.eq("variant_id", variantId)
      : branchQuery.is("variant_id", null);
    const { data: branchRow, error: rowError } = await branchQuery.maybeSingle();
    if (rowError) throw rowError;

    let balance: number | null;
    if (branchRow) {
      balance = (branchRow.stock_quantity ?? 0) + quantityChange;
      if (quantityChange < 0) this.assertNotBelowZero(productId, balance ?? 0);
      const { error: updateError } = await this.supabase
        .from("branch_inventory_overrides")
        .update({ stock_quantity: balance })
        .eq("id", branchRow.id);
      if (updateError) throw updateError;
      return;
    }

    balance = quantityChange;
    if (variantId) {
      const { data: variant } = await this.supabase
        .from("product_variants")
        .select("stock")
        .eq("id", variantId)
        .single();
      if (variant) balance = (variant.stock ?? 0) + quantityChange;
    } else {
      const { data: product } = await this.supabase
        .from("products")
        .select("stock")
        .eq("id", productId)
        .eq("store_id", storeId)
        .single();
      if (product) balance = (product.stock ?? 0) + quantityChange;
    }
    if (quantityChange < 0) this.assertNotBelowZero(productId, balance ?? 0);

    const { error: insertError } = await this.supabase
      .from("branch_inventory_overrides")
      .insert({
        branch_id: branchId,
        product_id: productId,
        variant_id: grain,
        stock_quantity: balance,
        reserved_quantity: 0,
      });
    if (insertError) throw insertError;
  }

  private assertNotBelowZero(productId: string, balance: number): void {
    if (balance < 0) {
      throw Object.assign(
        new Error(
          `Cannot adjust ${productId} stock below zero — reduce the write-off quantity`,
        ),
        { statusCode: 409 as const },
      );
    }
  }

  private async incrementVariantStock(
    productId: string,
    variantId: string,
    quantityChange: number,
  ): Promise<void> {
    const { data: variant } = await this.supabase
      .from("product_variants")
      .select("stock")
      .eq("id", variantId)
      .eq("product_id", productId)
      .single();
    if (!variant) return;

    const balance = (variant.stock ?? 0) + quantityChange;
    if (quantityChange < 0) this.assertNotBelowZero(variantId, balance);

    const { error } = await this.supabase
      .from("product_variants")
      .update({ stock: balance })
      .eq("id", variantId);
    if (error) throw error;
  }

  private async incrementProductStock(
    storeId: string,
    productId: string,
    quantityChange: number,
    unitCost?: number,
  ): Promise<void> {
    const { data: product } = await this.supabase
      .from("products")
      .select("stock")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();
    if (!product) return;

    const balance = (product.stock ?? 0) + quantityChange;
    if (quantityChange < 0) this.assertNotBelowZero(productId, balance);

    const productUpdates: Record<string, number> = {
      stock: balance,
    };
    if (unitCost !== undefined) productUpdates.cost = unitCost;

    const { error } = await this.supabase
      .from("products")
      .update(productUpdates)
      .eq("id", productId)
      .eq("store_id", storeId);
    if (error) throw error;
  }

  // ============================================================================
  // Stock transfers (branch → branch)
  // ============================================================================

  /**
   * Create a transfer header + lines in `draft`. Nothing is dispatched yet —
   * stock only leaves the source branch when the merchant sends it.
   */
  async createStockTransfer(
    storeId: string,
    input: {
      reference?: string;
      from_branch_id: string;
      to_branch_id: string;
      expected_at?: string;
      notes?: string;
      lines: Array<{
        product_id: string;
        variant_id?: string;
        quantity: number;
        unit_cost?: number;
      }>;
    },
  ): Promise<{ id: string; reference: string }> {
    await this.assertBranchBelongsToStore(storeId, input.from_branch_id);
    await this.assertBranchBelongsToStore(storeId, input.to_branch_id);

    if (input.from_branch_id === input.to_branch_id) {
      throw Object.assign(
        new Error("Source and destination branches must be different"),
        { statusCode: 400 as const },
      );
    }

    const reference =
      input.reference || (await this.nextTransferReference(storeId));

    const { data: transfer, error } = await this.supabase
      .from("stock_transfers")
      .insert({
        store_id: storeId,
        reference,
        from_branch_id: input.from_branch_id,
        to_branch_id: input.to_branch_id,
        expected_at: input.expected_at || null,
        notes: input.notes || null,
      })
      .select("id, reference")
      .single();
    if (error) throw error;

    const lines = input.lines.map((line) => ({
      transfer_id: transfer.id,
      product_id: line.product_id,
      variant_id: line.variant_id || null,
      quantity: line.quantity,
      received_quantity: 0,
      unit_cost: line.unit_cost ?? null,
    }));
    const { error: linesError } = await this.supabase
      .from("stock_transfer_lines")
      .insert(lines);
    if (linesError) throw linesError;

    return { id: transfer.id, reference };
  }

  /**
   * Dispatch a draft transfer: decrement each line from the source branch,
   * then mark it in transit. A coarse availability pre-check across all lines
   * fails fast with a friendly 409 before anything is removed, so a
   * multi-line transfer either leaves fully or not at all in the common case;
   * decrement_product_stock's row-lock is the race-safe backstop.
   */
  async sendStockTransfer(
    storeId: string,
    transferId: string,
    userId: string,
  ): Promise<void> {
    const transfer = await this.loadTransfer(storeId, transferId, "draft");
    const lines = await this.loadTransferLines(transferId);

    await this.assertTransferStockAvailable(storeId, transfer, lines);

    // decrement_product_stock is EXECUTE-granted only to service_role (see
    // 20260829_branch_variant_stock.sql); the request-scoped user client
    // cannot call it, so use the admin client — same as the checkout path.
    const inventoryClient = this.getInventoryClient();

    for (const line of lines) {
      const { error: rpcError } = await inventoryClient.rpc(
        "decrement_product_stock",
        {
          p_product_id: line.product_id,
          p_branch_id: transfer.from_branch_id,
          p_quantity: line.quantity,
          p_variant_id: line.variant_id ?? null,
          p_reason: "transfer_out",
          p_reference_id: transfer.id,
          p_created_by: userId,
        },
      );
      this.assertTransferRpcSucceeded(rpcError, this.grainLabel(line));
    }

    const { error: updateError } = await this.supabase
      .from("stock_transfers")
      .update({
        status: "in_transit",
        sent_at: new Date().toISOString(),
        sent_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transferId);
    if (updateError) throw updateError;
  }

  /**
   * Accept an in-transit transfer: increment the destination branch by each
   * line's received quantity and settle the header as received (or
   * partial_received when a line arrived short). Mirrors bulkUpdateStock by
   * writing a movement then adjusting the branch balance.
   */
  async receiveStockTransfer(
    storeId: string,
    transferId: string,
    received: Array<{
      product_id: string;
      variant_id?: string;
      received_quantity: number;
    }>,
    userId: string,
  ): Promise<void> {
    const transfer = await this.loadTransfer(
      storeId,
      transferId,
      "in_transit",
    );
    const lines = await this.loadTransferLines(transferId);
    const receivedByGrain = new Map(
      received.map((line) => [
        this.grainKey(line.product_id, line.variant_id),
        line.received_quantity,
      ]),
    );

    for (const line of lines) {
      const key = this.grainKey(line.product_id, line.variant_id);
      const receivedQuantity = receivedByGrain.get(key);
      if (receivedQuantity === undefined) {
        throw Object.assign(
          new Error(
            `Missing received quantity for ${this.grainLabel(line)}`,
          ),
          { statusCode: 400 },
        );
      }
      if (receivedQuantity > line.quantity || receivedQuantity < 0) {
        throw Object.assign(
          new Error("Received quantity exceeds the sent quantity"),
          { statusCode: 400 },
        );
      }
    }

    for (const line of lines) {
      const receivedQuantity = receivedByGrain.get(
        this.grainKey(line.product_id, line.variant_id),
      )!;
      if (receivedQuantity === 0) {
        continue;
      }

      const { error: movementError } = await this.supabase
        .from("stock_movements")
        .insert({
          store_id: storeId,
          product_id: line.product_id,
          variant_id: line.variant_id || null,
          branch_id: transfer.to_branch_id,
          quantity_change: receivedQuantity,
          reason: "transfer_in",
          reference_id: transfer.id,
          reference_type: "stock_transfer",
          unit_cost: line.unit_cost ?? null,
          batch_number: line.batch_number ?? null,
          expiry_date: line.expiry_date ?? null,
          created_by: userId,
        });
      if (movementError) throw movementError;

      await this.adjustBranchStock(
        storeId,
        line.product_id,
        line.variant_id,
        transfer.to_branch_id,
        receivedQuantity,
      );
    }

    const fullyReceived = lines.every((line) => {
      const receivedQuantity = receivedByGrain.get(
        this.grainKey(line.product_id, line.variant_id),
      )!;
      return receivedQuantity === line.quantity;
    });

    const { error: updateError } = await this.supabase
      .from("stock_transfers")
      .update({
        status: fullyReceived ? "received" : "partial_received",
        received_at: new Date().toISOString(),
        received_by: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", transferId);
    if (updateError) throw updateError;
  }

  /**
   * Cancel a transfer and return any dispatched stock to the source branch.
   * Draft transfers have nothing to return; in-transit transfers were
   * decremented from the source, so each line's unreceived remainder is put
   * back with a correction movement so the ledger stays whole.
   */
  async cancelStockTransfer(
    storeId: string,
    transferId: string,
    userId: string,
  ): Promise<void> {
    const transfer = await this.loadTransfer(storeId, transferId);

    if (transfer.status === "received") {
      throw Object.assign(
        new Error("A received transfer cannot be cancelled"),
        { statusCode: 409 },
      );
    }
    if (transfer.status === "cancelled") return;

    const returning =
      transfer.status === "in_transit" ? await this.loadTransferLines(transferId) : [];

    for (const line of returning) {
      const toReturn = line.quantity - line.received_quantity;
      if (toReturn <= 0) continue;

      const { error: movementError } = await this.supabase
        .from("stock_movements")
        .insert({
          store_id: storeId,
          product_id: line.product_id,
          variant_id: line.variant_id || null,
          branch_id: transfer.from_branch_id,
          quantity_change: toReturn,
          reason: "adjustment",
          notes: `Stock returned after cancelling ${transfer.reference}`,
          reference_id: transfer.id,
          created_by: userId,
        });
      if (movementError) throw movementError;

      await this.adjustBranchStock(
        storeId,
        line.product_id,
        line.variant_id,
        transfer.from_branch_id,
        toReturn,
      );
    }

    const { error: updateError } = await this.supabase
      .from("stock_transfers")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", transferId);
    if (updateError) throw updateError;
  }

  /**
   * Full transfer including its lines (with product/variant names) for a
   * detail view, e.g. the receiving confirmation flow.
   */
  async getStockTransfer(
    storeId: string,
    transferId: string,
  ): Promise<{ transfer: any; lines: any[] }> {
    const transfer = await this.loadTransfer(storeId, transferId);
    const { data: rawLines, error } = await this.supabase
      .from("stock_transfer_lines")
      .select(
        "id, product_id, variant_id, quantity, received_quantity, unit_cost, batch_number, expiry_date, product:products(name), variant:product_variants(name)",
      )
      .eq("transfer_id", transferId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return { transfer, lines: rawLines || [] };
  }

  /**
   * Paginated transfer list with joined line summary and branch names.
   */
  async listStockTransfers(
    storeId: string,
    page = 1,
    pageSize = 10,
  ): Promise<{ transfers: any[]; total: number }> {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const [{ count, error: countError }, { data, error: dataError }] =
      await Promise.all([
        this.supabase
          .from("stock_transfers")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId),
        this.supabase
          .from("stock_transfers")
          .select(
            `
            id, reference, status, from_branch_id, to_branch_id,
            sent_at, expected_at, received_at, created_at,
            from_branch:store_branches!stock_transfers_from_branch_fk(name),
            to_branch:store_branches!stock_transfers_to_branch_fk(name)
          `,
          )
          .eq("store_id", storeId)
          .order("created_at", { ascending: false })
          .range(from, to),
      ]);
    if (countError) throw countError;
    if (dataError) throw dataError;

    const transferIds = (data || []).map((transfer: any) => transfer.id);
    const lineCountsByTransfer: Record<string, number> = {};
    let valuesByTransfer: Record<string, number> = {};
    if (transferIds.length > 0) {
      const { data: lines, error: linesError } = await this.supabase
        .from("stock_transfer_lines")
        .select("transfer_id, product_id, variant_id, quantity, unit_cost")
        .in("transfer_id", transferIds);
      if (linesError) throw linesError;

      const aggregated = await this.aggregateLineCountsAndValues(lines || []);
      for (const [transferId, count] of Object.entries(aggregated.counts)) {
        lineCountsByTransfer[transferId] = count;
      }
      valuesByTransfer = aggregated.values;
    }

    const transfers = (data || []).map((transfer: any) => ({
      ...transfer,
      item_count: lineCountsByTransfer[transfer.id] || 0,
      value: valuesByTransfer[transfer.id] || 0,
    }));

    return { transfers, total: count ?? 0 };
  }

  /**
   * Total each transfer's line count and value (quantity × unit cost). Costs
   * not captured on the line are resolved with one batched lookup over the
   * relevant products/variants — never one query per line.
   */
  private async aggregateLineCountsAndValues(
    lines: Array<{
      transfer_id: string;
      product_id: string;
      variant_id: string | null;
      quantity: number;
      unit_cost: number | null;
    }>,
  ): Promise<{
    counts: Record<string, number>;
    values: Record<string, number>;
  }> {
    const counts: Record<string, number> = {};
    const values: Record<string, number> = {};
    const missingVariantIds = new Set<string>();
    const missingProductIds = new Set<string>();
    for (const line of lines) {
      if (!line.unit_cost) {
        if (line.variant_id) missingVariantIds.add(line.variant_id);
        else missingProductIds.add(line.product_id);
      }
    }

    const variantCosts = new Map<string, number | null>();
    if (missingVariantIds.size > 0) {
      const { data } = await this.supabase
        .from("product_variants")
        .select("id, cost")
        .in("id", [...missingVariantIds]);
      for (const row of data || [])
        variantCosts.set(row.id, row.cost != null ? Number(row.cost) : null);
    }
    const productCosts = new Map<string, number | null>();
    if (missingProductIds.size > 0) {
      const { data } = await this.supabase
        .from("products")
        .select("id, cost")
        .in("id", [...missingProductIds]);
      for (const row of data || [])
        productCosts.set(row.id, row.cost != null ? Number(row.cost) : null);
    }

    for (const line of lines) {
      counts[line.transfer_id] = (counts[line.transfer_id] || 0) + 1;
      const cost =
        line.unit_cost ??
        (line.variant_id
          ? variantCosts.get(line.variant_id)
          : productCosts.get(line.product_id));
      values[line.transfer_id] =
        (values[line.transfer_id] || 0) + Number(cost || 0) * line.quantity;
    }
    return { counts, values };
  }

  /**
   * Load a transfer header, throwing a 404 unless it belongs to the store
   * and (when supplied) is in the expected status.
   */
  private async loadTransfer(
    storeId: string,
    transferId: string,
    expectedStatus?: string,
  ): Promise<any> {
    const { data: transfer, error } = await this.supabase
      .from("stock_transfers")
      .select("*")
      .eq("id", transferId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) throw error;
    if (!transfer) {
      throw Object.assign(new Error("Transfer not found"), {
        statusCode: 404,
      });
    }
    if (expectedStatus && transfer.status !== expectedStatus) {
      throw Object.assign(
        new Error(`Transfer must be ${expectedStatus} first`),
        { statusCode: 409 },
      );
    }
    return transfer;
  }

  private async loadTransferLines(transferId: string): Promise<any[]> {
    const { data: lines, error } = await this.supabase
      .from("stock_transfer_lines")
      .select(
        "id, product_id, variant_id, quantity, received_quantity, unit_cost, product:products(name), variant:product_variants(name)",
      )
      .eq("transfer_id", transferId);
    if (error) throw error;
    return lines || [];
  }

  /**
   * Coarse pre-check that the source branch can cover every line before any
   * decrement runs, so a multi-line send fails fast instead of halfway.
   * The RPC's row lock is still the authoritative guard against races.
   */
  private async assertTransferStockAvailable(
    storeId: string,
    transfer: any,
    lines: any[],
  ): Promise<void> {
    for (const line of lines) {
      const available = await this.getBranchOnHand(
        storeId,
        transfer.from_branch_id,
        line.product_id,
        line.variant_id ?? null,
      );
      if (available !== null && available < line.quantity) {
        throw Object.assign(
          new Error(
            `Not enough ${this.grainLabel(line)} on hand at the source branch`,
          ),
          { statusCode: 409 },
        );
      }
    }
  }

  /** Effective on-hand at a branch: the sparse override, else global grain. */
  private async getBranchOnHand(
    storeId: string,
    branchId: string,
    productId: string,
    variantId: string | null,
  ): Promise<number | null> {
    let overrideQuery = this.supabase
      .from("branch_inventory_overrides")
      .select("stock_quantity")
      .eq("branch_id", branchId)
      .eq("product_id", productId);
    overrideQuery = variantId
      ? overrideQuery.eq("variant_id", variantId)
      : overrideQuery.is("variant_id", null);
    const { data: override, error: overrideError } = await overrideQuery
      .maybeSingle();
    if (overrideError) throw overrideError;
    if (override?.stock_quantity != null) return Number(override.stock_quantity);

    if (variantId) {
      const { data: variant } = await this.supabase
        .from("product_variants")
        .select("stock")
        .eq("id", variantId)
        .eq("product_id", productId)
        .single();
      return variant ? Number(variant.stock) : null;
    }
    const { data: product } = await this.supabase
      .from("products")
      .select("stock")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();
    return product ? Number(product.stock) : null;
  }

  private assertTransferRpcSucceeded(error: any, itemLabel: string): void {
    if (!error) return;
    if (error.code === "P0001") {
      throw Object.assign(
        new Error(`Insufficient stock for ${itemLabel}`),
        { statusCode: 409 as const },
      );
    }
    throw error;
  }

  private grainKey(productId: string, variantId?: string): string {
    return `${productId}:${variantId ?? ""}`;
  }

  private grainLabel(line: any): string {
    const productName = line.product?.name || "item";
    if (line.variant?.name) return `${productName} — ${line.variant.name}`;
    return productName;
  }

  private async nextTransferReference(storeId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("stock_transfers")
      .select("reference")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const latest = data?.[0]?.reference;
    if (!latest) return "TR-0001";
    const match = /TR-(\d+)$/.exec(latest);
    const next = match ? Number(match[1]) + 1 : 1;
    return `TR-${String(next).padStart(4, "0")}`;
  }

  // ============================================================================
  // Stock counts (cycle counts)
  // ============================================================================

  /**
   * Start a count: create the header (draft) and capture each line's
   * system-expected on-hand plus its counted quantity. The count is inert —
   * no movement is written until the merchant applies it.
   */
  async createStockCount(
    storeId: string,
    input: {
      reference?: string;
      branch_id: string;
      scope?: string;
      count_date?: string;
      lines: Array<{
        product_id: string;
        variant_id?: string;
        counted_quantity: number;
      }>;
    },
    userId: string,
  ): Promise<{ id: string; reference: string }> {
    await this.assertBranchBelongsToStore(storeId, input.branch_id);

    const reference =
      input.reference || (await this.nextStockCountReference(storeId));

    const { data: count, error } = await this.supabase
      .from("stock_counts")
      .insert({
        store_id: storeId,
        branch_id: input.branch_id,
        reference,
        scope: input.scope === "selected" ? "selected" : "all",
        count_date: input.count_date || new Date().toISOString(),
        counted_by: userId,
      })
      .select("id, reference")
      .single();
    if (error) throw error;

    await this.captureStockCountLines(storeId, count.id, input.branch_id, input.lines);

    return { id: count.id, reference };
  }

  /**
   * Add a single line to an in-progress count (used when the scope is
   * "selected" and the counter adds items one at a time).
   */
  async addStockCountLine(
    storeId: string,
    countId: string,
    input: {
      product_id: string;
      variant_id?: string;
      counted_quantity: number;
    },
  ): Promise<void> {
    const count = await this.loadStockCount(storeId, countId, "draft");
    await this.captureStockCountLines(storeId, countId, count.branch_id, [
      input,
    ]);
  }

  /**
   * Resolve each line's system on-hand and unit cost, then insert the rows.
   * Batch the cost lookup so a multi-line count never hits the DB once per
   * line.
   */
  private async captureStockCountLines(
    storeId: string,
    countId: string,
    branchId: string,
    lines: Array<{
      product_id: string;
      variant_id?: string;
      counted_quantity: number;
    }>,
  ): Promise<void> {
    const variantIds = new Set<string>();
    const productIds = new Set<string>();
    for (const line of lines) {
      if (line.variant_id) variantIds.add(line.variant_id);
      else productIds.add(line.product_id);
    }

    const variantCosts = new Map<string, number | null>();
    if (variantIds.size > 0) {
      const { data } = await this.supabase
        .from("product_variants")
        .select("id, cost")
        .in("id", [...variantIds]);
      for (const row of data || [])
        variantCosts.set(row.id, row.cost != null ? Number(row.cost) : null);
    }
    const productCosts = new Map<string, number | null>();
    if (productIds.size > 0) {
      const { data } = await this.supabase
        .from("products")
        .select("id, cost")
        .in("id", [...productIds]);
      for (const row of data || [])
        productCosts.set(row.id, row.cost != null ? Number(row.cost) : null);
    }

    const rows = [];
    for (const line of lines) {
      const systemQuantity = await this.getBranchOnHand(
        storeId,
        branchId,
        line.product_id,
        line.variant_id ?? null,
      );
      const unitCost = line.variant_id
        ? variantCosts.get(line.variant_id) ?? null
        : productCosts.get(line.product_id) ?? null;
      rows.push({
        count_id: countId,
        product_id: line.product_id,
        variant_id: line.variant_id || null,
        system_quantity: systemQuantity ?? 0,
        counted_quantity: Math.max(0, Math.floor(line.counted_quantity)),
        unit_cost: unitCost,
      });
    }

    const { error } = await this.supabase.from("stock_count_lines").insert(rows);
    if (error) throw error;
  }

  /**
   * Full count including its lines (with product/variant names, variance and
   * value impact) for the detail drawer.
   */
  async getStockCount(
    storeId: string,
    countId: string,
  ): Promise<{ count: any; lines: any[] }> {
    const count = await this.loadStockCount(storeId, countId);
    const { data: rawLines, error } = await this.supabase
      .from("stock_count_lines")
      .select(
        "id, product_id, variant_id, system_quantity, counted_quantity, unit_cost, product:products(name), variant:product_variants(name)",
      )
      .eq("count_id", countId)
      .order("created_at", { ascending: true });
    if (error) throw error;

    const lines = (rawLines || []).map((line: any) =>
      this.decorateCountLine(line),
    );
    return { count, lines };
  }

  /**
   * Paginated count list with branch name, counter name and per-count totals
   * (line count, aggregate variance, value impact).
   */
  async listStockCounts(
    storeId: string,
    page = 1,
    pageSize = 10,
  ): Promise<{ counts: any[]; total: number }> {
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;

    const [{ count, error: countError }, { data, error: dataError }] =
      await Promise.all([
        this.supabase
          .from("stock_counts")
          .select("id", { count: "exact", head: true })
          .eq("store_id", storeId),
        this.supabase
          .from("stock_counts")
          .select(
            `
            id, reference, status, branch_id, scope, count_date,
            applied_at, created_at,
            branch:store_branches!stock_counts_branch_fk(name),
            counter:users!stock_counts_counted_by_fkey(name)
          `,
          )
          .eq("store_id", storeId)
          .order("created_at", { ascending: false })
          .range(from, to),
      ]);
    if (countError) throw countError;
    if (dataError) throw dataError;

    const countIds = (data || []).map((row: any) => row.id);
    const linesByCount = new Map<string, any[]>();
    if (countIds.length > 0) {
      const { data: lines, error: linesError } = await this.supabase
        .from("stock_count_lines")
        .select("count_id, system_quantity, counted_quantity, unit_cost")
        .in("count_id", countIds);
      if (linesError) throw linesError;
      for (const line of lines || []) {
        const bucket = linesByCount.get(line.count_id) || [];
        bucket.push(line);
        linesByCount.set(line.count_id, bucket);
      }
    }

    const counts = (data || []).map((row: any) => {
      const lines = linesByCount.get(row.id) || [];
      const variant = lines.reduce(
        (acc, line) => acc + line.counted_quantity - line.system_quantity,
        0,
      );
      const value = lines.reduce(
        (acc, line) =>
          acc + (line.counted_quantity - line.system_quantity) * Number(line.unit_cost || 0),
        0,
      );
      return {
        ...row,
        item_count: lines.length,
        variance: variant,
        value_impact: value,
        counter_name: row.counter?.name || null,
      };
    });

    return { counts, total: count ?? 0 };
  }

  /**
   * Apply a draft count: post each non-zero variance as a count-reason
   * movement on the branch (rattling the ledger + the branch balance), then
   * mark the count applied. A count with zero net variance still posts, but
   * only the affected lines get movements.
   */
  async applyStockCount(
    storeId: string,
    countId: string,
    userId: string,
  ): Promise<void> {
    const count = await this.loadStockCount(storeId, countId, "draft");
    const { data: lines, error } = await this.supabase
      .from("stock_count_lines")
      .select("id, product_id, variant_id, system_quantity, counted_quantity")
      .eq("count_id", countId);
    if (error) throw error;

    for (const line of lines || []) {
      const variance = line.counted_quantity - line.system_quantity;
      if (variance === 0) continue;

      const { error: movementError } = await this.supabase
        .from("stock_movements")
        .insert({
          store_id: storeId,
          product_id: line.product_id,
          variant_id: line.variant_id || null,
          branch_id: count.branch_id,
          quantity_change: variance,
          reason: "count",
          reference_id: countId,
          effective_at: count.count_date,
          notes: `Stock count ${count.reference}`,
          created_by: userId,
        });
      if (movementError) throw movementError;

      await this.adjustBranchStock(
        storeId,
        line.product_id,
        line.variant_id || undefined,
        count.branch_id,
        variance,
      );
    }

    const { error: updateError } = await this.supabase
      .from("stock_counts")
      .update({
        status: "applied",
        applied_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", countId);
    if (updateError) throw updateError;
  }

  /**
   * Discard an in-progress count. A draft never touched stock, so nothing is
   * returned; it is simply marked cancelled.
   */
  async cancelStockCount(
    storeId: string,
    countId: string,
  ): Promise<void> {
    await this.loadStockCount(storeId, countId, "draft");

    const { error } = await this.supabase
      .from("stock_counts")
      .update({
        status: "cancelled",
        updated_at: new Date().toISOString(),
      })
      .eq("id", countId);
    if (error) throw error;
  }

  /**
   * Load a count header, throwing a 404 unless it belongs to the store and
   * (when supplied) is in the expected status.
   */
  private async loadStockCount(
    storeId: string,
    countId: string,
    expectedStatus?: string,
  ): Promise<any> {
    const { data: count, error } = await this.supabase
      .from("stock_counts")
      .select("*")
      .eq("id", countId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (error) throw error;
    if (!count) {
      throw Object.assign(new Error("Stock count not found"), {
        statusCode: 404,
      });
    }
    if (expectedStatus && count.status !== expectedStatus) {
      throw Object.assign(
        new Error(`Stock count must be ${expectedStatus} first`),
        { statusCode: 409 },
      );
    }
    return count;
  }

  /** Add computed variance / value-impact fields to a raw count line. */
  private decorateCountLine(line: any): any {
    const variance = line.counted_quantity - line.system_quantity;
    return {
      ...line,
      variance,
      value_impact: variance * Number(line.unit_cost || 0),
    };
  }

  private async nextStockCountReference(storeId: string): Promise<string> {
    const { data, error } = await this.supabase
      .from("stock_counts")
      .select("reference")
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) throw error;
    const latest = data?.[0]?.reference;
    if (!latest) return "SC-0001";
    const match = /SC-(\d+)$/.exec(latest);
    const next = match ? Number(match[1]) + 1 : 1;
    return `SC-${String(next).padStart(4, "0")}`;
  }

  /**
   * Get products with low stock (threshold <= 5)
   */
  /**
   * Flat inventory view: physical products plus their variants and each
   * row's per-branch balances. This is the single source the store inventory
   * tab reads instead of paging the entire product catalogue just to get
   * physical items. Rows mirror the frontend Product shape so a variant
   * product's real stock lives on its variants.
   *
   * When `page`/`pageSize` are supplied the result is bounded and a matching
   * total is returned (with optional `search` narrowing by name/SKU) so the
   * overview table can paginate server-side. Without them the whole physical
   * set is returned, preserving callers that need everything (low-stock
   * aggregation, the Locations per-branch summary).
   */
  async getInventoryProducts(
    storeId: string,
    options: { page?: number; pageSize?: number; search?: string } = {},
  ): Promise<{ products: any[]; total: number } | any[]> {
    const paginated = options.page !== undefined && options.pageSize !== undefined;
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 50;
    const search = options.search?.trim().toLowerCase();

    let countQuery = this.supabase
      .from("products")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .eq("type", "physical");
    let dataQuery = this.supabase
      .from("products")
      .select(`${PRODUCT_PUBLIC_COLUMNS}, variants:product_variants(${VARIANT_COLUMNS})`)
      .eq("store_id", storeId)
      .eq("type", "physical");

    if (search) {
      // products has no sku column (it only lives on product_variants —
      // 20260101_add_product_subtypes.sql) — the sku.ilike clause this used
      // to include 500'd every search with "column products.sku does not
      // exist". Name-only until variant-sku search is worth a real join.
      countQuery = countQuery.ilike("name", `%${search}%`);
      dataQuery = dataQuery.ilike("name", `%${search}%`);
    }
    if (paginated) {
      dataQuery = dataQuery.order("created_at", { ascending: false })
        .range((page - 1) * pageSize, page * pageSize - 1);
    } else {
      dataQuery = dataQuery.order("created_at", { ascending: false });
    }

    const [{ count, error: countError }, { data: products, error: productError }] =
      await Promise.all([countQuery, dataQuery]);

    if (countError) throw countError;
    if (productError) throw productError;

    const productRows = (products as any[]) || [];
    const { byProduct: balancesByProduct } =
      await this.buildBranchBalances(storeId, productRows);

    const built = productRows.map((row: any) => {
      const variants = (row.variants || []).map((variant: any) => ({
        ...variant,
        cost: variant.cost ?? null,
        price_adjustment: variant.price_adjustment ?? 0,
      }));
      return {
        ...row,
        variants,
        branch_stock: balancesByProduct[row.id] || {},
      };
    });

    if (!paginated) return built;
    return { products: built, total: count ?? 0 };
  }

  /** Map stored branch balances onto their products for the inventory view. */
  private async buildBranchBalances(
    storeId: string,
    productRows: any[],
  ): Promise<{
    byProduct: Record<
      string,
      Record<string, { stock: number | null; branchName: string }>
    >;
  }> {
    const productIds = productRows.map((row) => row.id);
    let overrides: Array<{
      product_id: string;
      variant_id: string | null;
      branch_id: string;
      stock_quantity: number | null;
      reserved_quantity: number;
      branch: unknown;
    }> = [];
    if (productIds.length > 0) {
      const { data, error } = await this.supabase
        .from("branch_inventory_overrides")
        .select(
          "product_id, variant_id, branch_id, stock_quantity, reserved_quantity, branch:store_branches(id, name)",
        )
        .in("product_id", productIds);
      if (error) throw error;
      overrides = (data || []) as unknown as typeof overrides;
    }

    const byProduct: Record<
      string,
      Record<string, { stock: number | null; branchName: string }>
    > = {};
    for (const override of overrides) {
      const grainKey = override.variant_id ?? "";
      byProduct[override.product_id] ??= {};
      const key = `${override.branch_id}:${grainKey}`;
      const branch = Array.isArray(override.branch)
        ? (override.branch as { id: string; name: string }[])[0]
        : (override.branch as { id: string; name: string } | null);
      byProduct[override.product_id][key] = {
        stock: override.stock_quantity,
        branchName: branch?.name ?? "Unnamed branch",
      };
    }
    return { byProduct };
  }

  /** Products whose stock (flat, variant, or per-branch balance) sits at or
   * below the threshold. Flat stock counts when a branch balance is absent;
   * per-branch rows surface the branch so the UI can point at where the gap
   * is. Intended as a compact alert list, so rows are trimmed to what the
   * Overview needs.
   */
  async getLowStockProducts(
    storeId: string,
    limit: number = 10,
    threshold: number = 5,
  ): Promise<any[]> {
    const products = (await this.getInventoryProducts(storeId, {
      page: 1,
      pageSize: Number.MAX_SAFE_INTEGER,
    })) as { products: any[]; total: number };
    const productList = products.products;

    const rows: Array<{
      product_id: string;
      variant_id: string | null;
      name: string;
      stock: number | null;
      branch_id?: string;
      branch_name?: string;
      cover_image: string | null;
    }> = [];

    for (const product of productList) {
      const variants = product.variants || [];

      if (variants.length === 0) {
        const flatStock = product.stock ?? null;
        if (flatStock !== null && flatStock <= threshold) {
          rows.push({
            product_id: product.id,
            variant_id: null,
            name: product.name,
            stock: flatStock,
            cover_image: product.cover_image,
          });
        }
      } else {
        for (const variant of variants) {
          if (variant.stock === null || variant.stock > threshold) continue;
          rows.push({
            product_id: product.id,
            variant_id: variant.id,
            name: product.name,
            stock: variant.stock,
            cover_image: product.cover_image,
          });
        }
      }

      for (const [key, balance] of Object.entries(product.branch_stock || {})) {
        const stock = (balance as { stock: number | null }).stock;
        if (stock === null || stock > threshold) continue;
        const branchName = (balance as { branchName: string }).branchName;
        const [branchId, variantId] = key.split(":");
        const variant = variants.find((v: any) => v.id === variantId);
        rows.push({
          product_id: product.id,
          variant_id: variantId || null,
          branch_id: branchId,
          branch_name: branchName,
          name: variant ? `${product.name} — ${variant.name}` : product.name,
          stock,
          cover_image: product.cover_image,
        });
      }
    }

    return rows.slice(0, limit);
  }  // ============================================================================
  // Registers — named till devices (registers-prd-full.md Phase 4). A
  // branch can run several registers concurrently; the partial unique index
  // on register_shifts enforces at most one OPEN shift per register.
  // ============================================================================

  async listRegisters(
    storeId: string,
    filters: { branch_id?: string; status?: "active" | "inactive" } = {},
  ): Promise<any[]> {
    let query = this.supabase
      .from("registers")
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .eq("store_id", storeId)
      .order("created_at", { ascending: true });

    if (filters.branch_id) query = query.eq("branch_id", filters.branch_id);
    if (filters.status) query = query.eq("status", filters.status);

    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  async createRegister(
    storeId: string,
    data: {
      name: string;
      branch_id?: string | null;
      device_type?: string | null;
    },
    userId: string,
  ): Promise<any> {
    const { data: register, error } = await this.supabase
      .from("registers")
      .insert({
        store_id: storeId,
        name: data.name,
        branch_id: data.branch_id || null,
        device_type: data.device_type || null,
        created_by: userId,
        // Active immediately — a merchant creating a register from the
        // dashboard means to use it right away (e.g. via "Open POS"),
        // there's no pairing step to trigger activation on that path.
        // The status toggle exists to let them retire a register later,
        // not as a hidden required step after creation.
        status: "active",
      })
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .single();

    if (error) throw error;
    return register;
  }

  async updateRegister(
    registerId: string,
    data: {
      name?: string;
      branch_id?: string | null;
      device_type?: string | null;
      status?: "active" | "inactive";
    },
  ): Promise<any> {
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (data.name !== undefined) updates.name = data.name;
    if (data.branch_id !== undefined) updates.branch_id = data.branch_id;
    if (data.device_type !== undefined) updates.device_type = data.device_type;
    if (data.status !== undefined) {
      updates.status = data.status;
      if (data.status === "active")
        updates.paired_at = new Date().toISOString();
    }

    const { data: register, error } = await this.supabase
      .from("registers")
      .update(updates)
      .eq("id", registerId)
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .single();

    if (error) throw error;
    return register;
  }

  async deleteRegister(registerId: string): Promise<void> {
    const openShift = await this.getOpenRegisterShift(registerId);
    if (openShift) {
      throw Object.assign(
        new Error("Close this register's open shift before deleting it."),
        { statusCode: 400 },
      );
    }

    const { error } = await this.supabase
      .from("registers")
      .delete()
      .eq("id", registerId);

    if (error) throw error;
  }

  private hashRegisterToken(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  /**
   * A merchant-facing one-time code (16 digits, 15-minute expiry) — read
   * off the dashboard and typed into the cashier's device at /pos to
   * complete pairing. Only its hash is stored.
   */
  async generateRegisterPairingCode(
    registerId: string,
  ): Promise<{ code: string; expiresAt: string }> {
    const code = Array.from({ length: 16 }, () => crypto.randomInt(0, 10)).join(
      "",
    );
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const { data: updated, error } = await this.supabase
      .from("registers")
      .update({
        pairing_code_hash: this.hashRegisterToken(code),
        pairing_code_expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", registerId)
      .select("id")
      .single();

    if (error) throw error;
    if (!updated) {
      throw Object.assign(
        new Error(
          "Register not found or insufficient permissions to generate a pairing code.",
        ),
        { statusCode: 404 },
      );
    }
    return { code, expiresAt };
  }

  /**
   * Exchanges a one-time pairing code for a long-lived device token — the
   * bearer credential a cashier's device stores locally and sends on every
   * /pos request thereafter, no dashboard login involved. Called with the
   * service-role client (public route, runs before any auth exists).
   */
  async pairRegisterDevice(
    pairingCode: string,
  ): Promise<{ deviceToken: string; register: any }> {
    const codeHash = this.hashRegisterToken(pairingCode);
    const { data: register, error } = await this.supabase
      .from("registers")
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, pairing_code_hash, pairing_code_expires_at, branch:store_branches(id, name), store:stores(id, name, slug, pos_pin_mode)",
      )
      .eq("pairing_code_hash", codeHash)
      .maybeSingle();

    if (error) throw error;
    if (
      !register ||
      !register.pairing_code_expires_at ||
      new Date(register.pairing_code_expires_at) < new Date()
    ) {
      throw Object.assign(
        new Error("This pairing code is invalid or has expired."),
        { statusCode: 400 },
      );
    }

    const deviceToken = crypto.randomBytes(32).toString("hex");

    const { data: updated, error: updateError } = await this.supabase
      .from("registers")
      .update({
        device_token_hash: this.hashRegisterToken(deviceToken),
        pairing_code_hash: null,
        pairing_code_expires_at: null,
        status: "active",
        paired_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", register.id)
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name), store:stores(id, name, slug, pos_pin_mode)",
      )
      .single();

    if (updateError) throw updateError;
    return { deviceToken, register: updated };
  }

  /**
   * Resolves a device's bearer token back to its register — used by the
   * authenticateRegisterDevice middleware on every /pos request. Called
   * with the service-role client (no auth.uid() exists for a device).
   */
  async getRegisterByDeviceToken(deviceToken: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from("registers")
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name), store:stores(id, name, slug, pos_pin_mode)",
      )
      .eq("device_token_hash", this.hashRegisterToken(deviceToken))
      .eq("status", "active")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /** Revokes a paired device's access — the register must be re-paired. */
  async unpairRegisterDevice(registerId: string): Promise<any> {
    const { data, error } = await this.supabase
      .from("registers")
      .update({
        device_token_hash: null,
        paired_at: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", registerId)
      .select(
        "id, store_id, branch_id, name, device_type, register_version, status, paired_at, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .single();

    if (error) throw error;
    return data;
  }

  // ============================================================================
  // Staff PINs (registers-prd-full.md Phase 5) — identifies the PERSON
  // operating an already-paired till, so sales/shifts attribute to a
  // specific staff member without that person needing a dashboard login.
  // ============================================================================

  private hashPosPin(pin: string): string {
    // A pepper (not a per-record salt) so store_id + pin_hash stays a valid
    // equality lookup, same trade-off as hashRegisterToken — the pepper
    // just raises the bar above a bare, crackable SHA-256(pin) for a
    // dumped table, since a 4-digit PIN has only 10,000 possibilities.
    const pepper = process.env.POS_PIN_PEPPER || "hilaq-pos-pin-pepper-v1";
    return crypto.createHash("sha256").update(`${pin}:${pepper}`).digest("hex");
  }

  async listPosStaff(storeId: string): Promise<any[]> {
    const { data, error } = await this.supabase
      .from("pos_staff")
      .select(
        "id, store_id, user_id, branch_id, name, status, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .eq("store_id", storeId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  async createPosStaff(
    storeId: string,
    data: {
      name: string;
      pin: string;
      user_id?: string;
      branch_id?: string | null;
    },
    userId: string,
  ): Promise<any> {
    const { data: staff, error } = await this.supabase
      .from("pos_staff")
      .insert({
        store_id: storeId,
        name: data.name,
        user_id: data.user_id || null,
        branch_id: data.branch_id || null,
        pin_hash: this.hashPosPin(data.pin),
        created_by: userId,
      })
      .select(
        "id, store_id, user_id, branch_id, name, status, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .single();

    if (error) {
      // Partial unique indexes: (store_id, pin_hash) and (store_id, user_id),
      // both scoped to status='active'.
      if ((error as any).code === "23505") {
        throw Object.assign(
          new Error(
            "Another active staff member already uses this PIN or this team member already has a PIN.",
          ),
          { statusCode: 409 },
        );
      }
      throw error;
    }
    return staff;
  }

  async updatePosStaff(
    staffId: string,
    data: {
      name?: string;
      pin?: string;
      status?: "active" | "inactive";
      branch_id?: string | null;
    },
  ): Promise<any> {
    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };
    if (data.name !== undefined) updates.name = data.name;
    if (data.pin !== undefined) updates.pin_hash = this.hashPosPin(data.pin);
    if (data.status !== undefined) updates.status = data.status;
    if (data.branch_id !== undefined) updates.branch_id = data.branch_id;

    const { data: staff, error } = await this.supabase
      .from("pos_staff")
      .update(updates)
      .eq("id", staffId)
      .select(
        "id, store_id, user_id, branch_id, name, status, created_by, created_at, updated_at, branch:store_branches(id, name)",
      )
      .single();

    if (error) {
      if ((error as any).code === "23505") {
        throw Object.assign(
          new Error("Another active staff member already uses this PIN."),
          { statusCode: 409 },
        );
      }
      throw error;
    }
    return staff;
  }

  async deletePosStaff(staffId: string): Promise<void> {
    const { error } = await this.supabase
      .from("pos_staff")
      .delete()
      .eq("id", staffId);
    if (error) throw error;
  }

  /**
   * Resolves a PIN to a staff member — scoped to the store the paired
   * device belongs to (never trusts a store_id from the request itself).
   * When the register has a branch, staff whose PIN is scoped to a
   * *different* branch are excluded — branch_id IS NULL means "works
   * anywhere" (e.g. a floating manager). Called with the service-role
   * client from requireRegisterDevice, same as the register-device lookups.
   *
   * expectedStaffId narrows this from "identify whoever this PIN belongs
   * to" (used to establish/change who's operating the till — Open register,
   * Switch user) to "re-confirm this SPECIFIC staff member" (used for the
   * per-sale/close-shift re-prompts, which are meant to be a self-reauth
   * step on the already-active operator, not an opening for a different
   * staff member's PIN to act on their behalf). A mismatch is treated
   * identically to an unrecognized PIN — same generic error either way, so
   * a wrong PIN never reveals whether it belonged to someone else.
   */
  async verifyPosStaffPin(
    storeId: string,
    pin: string,
    branchId?: string | null,
    expectedStaffId?: string,
  ): Promise<any | null> {
    let query = this.supabase
      .from("pos_staff")
      .select("id, name, branch_id")
      .eq("store_id", storeId)
      .eq("pin_hash", this.hashPosPin(pin))
      .eq("status", "active");

    if (branchId) {
      query = query.or(`branch_id.is.null,branch_id.eq.${branchId}`);
    }

    const { data, error } = await query.maybeSingle();

    if (error) throw error;
    if (expectedStaffId && data?.id !== expectedStaffId) return null;
    return data;
  }

  async getOpenRegisterShift(registerId: string): Promise<any | null> {
    const { data, error } = await this.supabase
      .from("register_shifts")
      .select("*")
      .eq("register_id", registerId)
      .eq("status", "open")
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  async openRegisterShift(
    registerId: string,
    userId: string | null,
    startingFloat: number,
    staffId?: string | null,
  ): Promise<any> {
    const { data: register, error: registerError } = await this.supabase
      .from("registers")
      .select("id, branch_id")
      .eq("id", registerId)
      .single();

    if (registerError || !register) {
      throw Object.assign(new Error("Register not found"), { statusCode: 404 });
    }
    if (!register.branch_id) {
      throw Object.assign(
        new Error("Assign this register to a branch before opening a shift."),
        { statusCode: 400 },
      );
    }

    const existing = await this.getOpenRegisterShift(registerId);
    if (existing) {
      throw Object.assign(
        new Error("A shift is already open for this register."),
        { statusCode: 409 },
      );
    }

    const { data, error } = await this.supabase
      .from("register_shifts")
      .insert({
        register_id: registerId,
        branch_id: register.branch_id,
        opened_by: userId,
        opened_by_staff_id: staffId || null,
        starting_float: startingFloat,
        status: "open",
      })
      .select("*")
      .single();

    if (error) throw error;
    return data;
  }

  // Sum cash-method orders rung up against this shift — the only
  // component of "expected cash" beyond the starting float until Phase 3
  // (register_cash_movements) adds paid-in/paid-out entries. Shared between
  // closeRegisterShift (final reconciliation) and getRegisterShiftSummary
  // (a live preview of the same numbers while the shift is still open).
  private async computeShiftCashSummary(shift: {
    id: string;
    starting_float: number;
  }): Promise<{ cashSales: number; expectedCash: number }> {
    const { data: cashOrders, error: ordersError } = await this.supabase
      .from("store_orders")
      .select("total")
      .eq("register_shift_id", shift.id)
      .eq("payment_method", "cash")
      .in("status", ["paid", "fulfilled"]);

    if (ordersError) throw ordersError;
    const cashSales = (cashOrders || []).reduce(
      (sum, o) => sum + Number(o.total || 0),
      0,
    );

    return {
      cashSales,
      expectedCash: Number(shift.starting_float) + cashSales,
    };
  }

  /**
   * Float, cash sales so far, and the resulting expected-cash figure for an
   * open shift — lets the close-register modal show a cashier what they're
   * reconciling against BEFORE they type in a counted-cash number, rather
   * than only finding out the expected figure after the fact.
   */
  async getRegisterShiftSummary(
    shiftId: string,
    expectedRegisterId?: string,
  ): Promise<{
    starting_float: number;
    cash_sales: number;
    expected_cash: number;
  }> {
    const { data: shift, error: shiftError } = await this.supabase
      .from("register_shifts")
      .select("id, register_id, starting_float")
      .eq("id", shiftId)
      .single();

    if (shiftError || !shift) {
      throw Object.assign(new Error("Shift not found"), { statusCode: 404 });
    }
    if (expectedRegisterId && shift.register_id !== expectedRegisterId) {
      throw Object.assign(
        new Error("This shift does not belong to your register."),
        {
          statusCode: 403,
        },
      );
    }

    const { cashSales, expectedCash } =
      await this.computeShiftCashSummary(shift);
    return {
      starting_float: Number(shift.starting_float),
      cash_sales: cashSales,
      expected_cash: expectedCash,
    };
  }

  async closeRegisterShift(
    shiftId: string,
    userId: string | null,
    countedCash: number,
    notes?: string,
    // Set only when called via a device-paired /pos request (which runs
    // with the service-role client, bypassing RLS) — verified so a device
    // can only ever close its own register's shift.
    expectedRegisterId?: string,
    staffId?: string | null,
  ): Promise<any> {
    const { data: shift, error: shiftError } = await this.supabase
      .from("register_shifts")
      .select("*")
      .eq("id", shiftId)
      .single();

    if (shiftError || !shift) {
      throw Object.assign(new Error("Shift not found"), { statusCode: 404 });
    }
    if (expectedRegisterId && shift.register_id !== expectedRegisterId) {
      throw Object.assign(
        new Error("This shift does not belong to your register."),
        {
          statusCode: 403,
        },
      );
    }
    if (shift.status !== "open") {
      throw Object.assign(new Error("This shift is already closed."), {
        statusCode: 400,
      });
    }

    const { expectedCash } = await this.computeShiftCashSummary(shift);
    const variance = countedCash - expectedCash;

    const { data: updated, error: updateError } = await this.supabase
      .from("register_shifts")
      .update({
        closed_by: userId,
        closed_by_staff_id: staffId || null,
        closed_at: new Date().toISOString(),
        counted_cash: countedCash,
        expected_cash: expectedCash,
        variance,
        status: "closed",
        notes: notes ?? shift.notes,
        updated_at: new Date().toISOString(),
      })
      .eq("id", shiftId)
      .select("*")
      .single();

    if (updateError) throw updateError;
    return updated;
  }

  /**
   * Price a ticket without creating an order — lets the POS screen show the
   * cashier a real tax/service-charge-inclusive total (so cash change is
   * computed correctly) as the ticket changes, without duplicating the
   * pricing formula on the frontend.
   */
  async previewPosOrder(data: {
    store_id: string;
    branch_id: string;
    fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
    items: CheckoutItemInput[];
    discount_code?: string;
    customer_email?: string;
  }): Promise<OrderPricing> {
    await this.assertBranchAcceptingOrders(data.branch_id);

    const { items: itemsWithPrices } = await this.resolveOrderItemPricing(
      data.store_id,
      data.items,
      data.branch_id,
    );

    return this.computeOrderPricing({
      items: itemsWithPrices,
      storeId: data.store_id,
      branchId: data.branch_id,
      fulfillmentType: data.fulfillment_type,
      discountCode: data.discount_code,
      customerEmail: data.customer_email,
      deliveryFee: 0,
    });
  }

  /**
   * Ring up a till sale. Reuses the exact same server-derived pricing as
   * online checkout (resolveOrderItemPricing/computeOrderPricing) so a
   * cashier and a customer never see different totals for the same cart.
   * Unlike online checkout, no payment-provider verification is needed —
   * cash/card-terminal payment is already reconciled at the till, so the
   * order lands directly as "paid".
   */
  async createPosOrder(data: {
    store_id: string;
    branch_id: string;
    register_id?: string;
    fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
    customer?: { name?: string; email?: string; phone?: string };
    items: CheckoutItemInput[];
    discount_code?: string;
    payment_method: "cash" | "card" | "transfer";
    register_shift_id?: string;
    notes?: string;
    createdBy: string | null;
    staffId?: string | null;
    idempotencyKey?: string | null;
  }): Promise<{ order: any; unattachedToShift: boolean }> {
    // A retried submission (client-side "Failed to fetch" retry, or a
    // cashier tapping "Complete sale" twice) replays the same key. If an
    // order already exists for it, hand back that order instead of
    // re-pricing/re-decrementing stock — makes retries safe rather than
    // just tolerated.
    if (data.idempotencyKey) {
      const { data: existing } = await this.supabase
        .from("store_orders")
        .select("*")
        .eq("store_id", data.store_id)
        .eq("idempotency_key", data.idempotencyKey)
        .maybeSingle();
      if (existing) {
        return {
          order: existing,
          unattachedToShift: !existing.register_shift_id,
        };
      }
    }

    await this.assertBranchAcceptingOrders(data.branch_id);

    const { items: itemsWithPrices } = await this.resolveOrderItemPricing(
      data.store_id,
      data.items,
      data.branch_id,
    );

    const {
      subtotal,
      discount,
      discountDetails,
      taxAmount,
      serviceChargeAmount,
      total,
    } = await this.computeOrderPricing({
        items: itemsWithPrices,
        storeId: data.store_id,
        branchId: data.branch_id,
        fulfillmentType: data.fulfillment_type,
        discountCode: data.discount_code,
        customerEmail: data.customer?.email,
        deliveryFee: 0,
      });

    // Attach to the given register's open shift unless a shift was
    // explicitly supplied. A supplied shift is re-verified against this
    // branch — never trusted outright — since createPosOrder can run with
    // the service-role client (a paired device has no RLS to fall back on).
    let registerShiftId: string | null = null;
    if (data.register_shift_id) {
      const { data: shift } = await this.supabase
        .from("register_shifts")
        .select("id, branch_id")
        .eq("id", data.register_shift_id)
        .maybeSingle();
      if (!shift || shift.branch_id !== data.branch_id) {
        throw Object.assign(
          new Error(
            "This register shift does not belong to the selected branch.",
          ),
          { statusCode: 400 },
        );
      }
      registerShiftId = shift.id;
    } else if (data.register_id) {
      const openShift = await this.getOpenRegisterShift(data.register_id);
      registerShiftId = openShift?.id || null;
    }

    // A cash sale with no open shift used to be allowed (just flagged via
    // unattachedToShift for the UI to warn about after the fact) — now a
    // hard requirement, checked before any side effect (stock decrement)
    // runs, so a bypass anywhere upstream can't slip through here either.
    if (!registerShiftId) {
      throw Object.assign(
        new Error(
          "A register shift must be open before you can complete a sale.",
        ),
        { statusCode: 400 },
      );
    }

    // Stock decrement reuses the exact same guarded path online orders use
    // (409 on insufficient stock), so POS sales can't oversell either.
    // The order id is pre-generated so the decrement and its stock_movements
    // ledger row can be linked to the order atomically (the RPC writes the
    // branch movement; the global path writes its own). No order row is
    // persisted unless the decrement succeeds, so the pre-generated id is
    // harmless on an insufficient-stock 409.
    const posOrderId = randomUUID();
    await this.decrementInventoryForOrderItems(itemsWithPrices, data.branch_id, {
      reference_id: posOrderId,
      created_by: data.createdBy,
    });

    // Walk-in sales often capture no customer identity at all.
    // store_orders.customer_name/customer_email are NOT NULL, so synthesize
    // a placeholder rather than fail the sale — but only upsert into
    // store_customers when a real email was actually captured.
    const hasRealEmail = !!data.customer?.email;
    const customerName = data.customer?.name || "Walk-in Customer";
    const customerEmail =
      data.customer?.email || `walkin-${Date.now()}@pos.hilaq.internal`;

    const orderNumber = generateOrderNumber();
    const paymentReference = createTransactionReference(REFERENCE_TYPES.ORDER);
    const now = new Date().toISOString();

    const order: any = {
      id: posOrderId,
      store_id: data.store_id,
      order_number: orderNumber,
      customer_name: customerName,
      customer_email: customerEmail,
      customer_phone: data.customer?.phone || null,
      customer_address: null,
      items: itemsWithPrices,
      subtotal,
      discount,
      discount_code: discount > 0 ? data.discount_code || null : null,
      discount_details: discountDetails,
      delivery_fee: 0,
      tax_amount: taxAmount,
      service_charge_amount: serviceChargeAmount,
      total,
      currency: "NGN",
      status: "paid",
      payment_reference: paymentReference,
      payment_method: data.payment_method,
      created_by: data.createdBy,
      staff_id: data.staffId || null,
      branch_id: data.branch_id,
      fulfillment_type: data.fulfillment_type || null,
      register_shift_id: registerShiftId,
      notes: data.notes || null,
      idempotency_key: data.idempotencyKey || null,
      created_at: now,
      updated_at: now,
    };

    const { data: savedOrder, error: orderError } = await this.supabase
      .from("store_orders")
      .insert([order])
      .select("*")
      .single();

    if (orderError) {
      // Unique-violation on the idempotency index means a concurrent
      // retry won the race and already inserted this order — the stock
      // decrement above already ran for it, so surfacing this insert as a
      // failure (and letting the client retry yet again) would double
      // count. Return the winner's row instead.
      if (orderError.code === "23505" && data.idempotencyKey) {
        const { data: existing } = await this.supabase
          .from("store_orders")
          .select("*")
          .eq("store_id", data.store_id)
          .eq("idempotency_key", data.idempotencyKey)
          .maybeSingle();
        if (existing) {
          return {
            order: existing,
            unattachedToShift: !existing.register_shift_id,
          };
        }
      }
      throw orderError;
    }

    if (discountDetails.length > 0) {
      await this.recordDiscountRedemptions(
        savedOrder,
        customerEmail,
        discountDetails,
      );
    }

    if (hasRealEmail) {
      await this.upsertCustomer(
        data.store_id,
        {
          name: customerName,
          email: customerEmail,
          phone: data.customer?.phone,
        },
        total,
      );
    }

    return { order: savedOrder, unattachedToShift: !registerShiftId };
  }

  /**
   * Get categories for a store (Merchant view - with product count)
   */
  async getStoreCategories(
    storeId: string,
    menuId?: string,
  ): Promise<StoreCategory[]> {
    let query = this.supabase
      .from("store_categories")
      .select("*")
      .eq("store_id", storeId)
      .neq("is_menu", true);

    if (menuId) {
      query = query.eq("parent_id", menuId);
    }

    const { data: categories, error: catError } = await query.order(
      "position",
      {
        ascending: true,
      },
    );

    if (catError) throw catError;

    // Get product counts for each category
    const { data: counts, error: countError } = await this.supabase
      .from("product_categories")
      .select("category_id");

    if (countError) throw countError;

    const countMap = (counts || []).reduce((acc: any, curr: any) => {
      acc[curr.category_id] = (acc[curr.category_id] || 0) + 1;
      return acc;
    }, {});

    return categories.map((cat: any) => ({
      ...cat,
      product_count: countMap[cat.id] || 0,
    }));
  }

  /**
   * Get public categories for a store (only active ones)
   */
  async getPublicCategories(storeId: string): Promise<
    Array<{
      id: string;
      name: string;
      slug: string;
      parent_id: string | null;
      description: string | null;
      product_count: number;
    }>
  > {
    const { data: categories, error } = await this.supabase
      .from("store_categories")
      .select("id, name, slug, parent_id, description")
      .eq("store_id", storeId)
      .eq("is_active", true)
      .order("position", { ascending: true });

    if (error) throw error;

    const catIds = categories.map((c) => c.id);
    const { data: counts } = await this.supabase
      .from("product_categories")
      .select("category_id")
      .in("category_id", catIds);

    const countMap = (counts || []).reduce((acc: any, curr: any) => {
      acc[curr.category_id] = (acc[curr.category_id] || 0) + 1;
      return acc;
    }, {});

    return categories.map((cat: any) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      parent_id: cat.parent_id ?? null,
      description: cat.description,
      product_count: countMap[cat.id] || 0,
    }));
  }

  /**
   * Create category
   */
  async createStoreCategory(
    storeId: string,
    data: Partial<StoreCategory>,
  ): Promise<StoreCategory> {
    const slug = data.slug || generateSlug(data.name || "");
    const { data: category, error } = await this.supabase
      .from("store_categories")
      .insert({
        ...data,
        store_id: storeId,
        slug,
      })
      .select("*")
      .single();

    if (error) throw error;
    return category;
  }

  /**
   * Update category
   */
  async updateStoreCategory(
    storeId: string,
    categoryId: string,
    updates: Partial<StoreCategory>,
  ): Promise<StoreCategory> {
    if (updates.name && !updates.slug) {
      updates.slug = generateSlug(updates.name);
    }

    const { data: category, error } = await this.supabase
      .from("store_categories")
      .update(updates)
      .eq("id", categoryId)
      .eq("store_id", storeId)
      .select("*")
      .single();

    if (error) throw error;
    return category;
  }

  /**
   * Delete category
   */
  async deleteStoreCategory(
    storeId: string,
    categoryId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("store_categories")
      .delete()
      .eq("id", categoryId)
      .eq("store_id", storeId);

    if (error) throw error;
  }

  /**
   * Reorder categories
   */
  async reorderStoreCategories(
    storeId: string,
    orders: Array<{ id: string; position: number }>,
  ): Promise<void> {
    for (const item of orders) {
      await this.supabase
        .from("store_categories")
        .update({ position: item.position })
        .eq("id", item.id)
        .eq("store_id", storeId);
    }
  }

  // ============================================================================
  // Store Branches Management (Food Store — PRD Phase 1)
  // ============================================================================

  /**
   * Get all branches for a store
   */
  async getStoreBranches(storeId: string): Promise<StoreBranch[]> {
    const { data, error } = await this.supabase
      .from("store_branches")
      .select("*")
      .eq("store_id", storeId)
      .order("created_at", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a branch
   */
  async createStoreBranch(
    storeId: string,
    data: Partial<StoreBranch>,
  ): Promise<StoreBranch> {
    // Only one branch can be default per store — demote any existing default first.
    if (data.is_default) {
      await this.supabase
        .from("store_branches")
        .update({ is_default: false })
        .eq("store_id", storeId)
        .eq("is_default", true);
    }

    const { data: branch, error } = await this.supabase
      .from("store_branches")
      .insert({
        ...data,
        store_id: storeId,
      })
      .select("*")
      .single();

    if (error) throw error;
    return branch;
  }

  /**
   * Update a branch
   */
  async updateStoreBranch(
    storeId: string,
    branchId: string,
    updates: Partial<StoreBranch>,
  ): Promise<StoreBranch> {
    if (updates.is_default) {
      await this.supabase
        .from("store_branches")
        .update({ is_default: false })
        .eq("store_id", storeId)
        .eq("is_default", true)
        .neq("id", branchId);
    }

    const { data: branch, error } = await this.supabase
      .from("store_branches")
      .update(updates)
      .eq("id", branchId)
      .eq("store_id", storeId)
      .select("*")
      .single();

    if (error) throw error;
    return branch;
  }

  /**
   * Delete a branch
   */
  async deleteStoreBranch(storeId: string, branchId: string): Promise<void> {
    const { error } = await this.supabase
      .from("store_branches")
      .delete()
      .eq("id", branchId)
      .eq("store_id", storeId);

    if (error) throw error;
  }

  // ============================================================================
  // Store QR Codes (Food Store) — named codes ("Table 12") a customer scans
  // to reach the storefront with a branch + fulfilment pre-resolved, so the
  // resulting order carries a label telling staff where to deliver it.
  // ============================================================================

  async getStoreQrCodes(
    storeId: string,
  ): Promise<Array<StoreQrCode & { url: string; qr_image: string }>> {
    const { data: branches, error } = await this.supabase
      .from("store_branches")
      .select("id, qr_codes")
      .eq("store_id", storeId);
    if (error) throw error;

    const allCodes: StoreQrCode[] = (branches || []).flatMap((b: any) =>
      (Array.isArray(b.qr_codes) ? b.qr_codes : []).map((q: any) => ({
        ...q,
        branch_id: b.id,
      })),
    );
    return this.attachQrCodeAssets(storeId, allCodes);
  }

  /**
   * Attaches the printable URL + QR PNG to each code, generated at request
   * time rather than stored — cheap (same generateQRCode util used for
   * event-ticket QR codes) and means a store rename never invalidates a
   * previously-downloaded sign.
   */
  private async attachQrCodeAssets(
    storeId: string,
    qrCodes: StoreQrCode[],
  ): Promise<Array<StoreQrCode & { url: string; qr_image: string }>> {
    if (qrCodes.length === 0) return [];
    const { data: store } = await this.supabase
      .from("stores")
      .select("slug")
      .eq("id", storeId)
      .single();
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";

    return Promise.all(
      qrCodes.map(async (qrCode) => {
        const url = `${frontendUrl}/s/${store?.slug}?qr=${qrCode.code}`;
        const qrImage = await generateQRCode(url);
        return { ...qrCode, url, qr_image: qrImage };
      }),
    );
  }

  /**
   * branch_id is required only when the store has more than one branch —
   * auto-filled from the store's single branch otherwise, mirroring how
   * import scripts default is_default when there's just one branch.
   */
  private async resolveQrCodeBranchId(
    storeId: string,
    branchId: string | null | undefined,
  ): Promise<string | null> {
    if (branchId) {
      const { data: branch } = await this.supabase
        .from("store_branches")
        .select("id")
        .eq("id", branchId)
        .eq("store_id", storeId)
        .single();
      if (!branch) {
        throw Object.assign(new Error("Branch not found"), { statusCode: 404 });
      }
      return branchId;
    }

    const { data: branches } = await this.supabase
      .from("store_branches")
      .select("id")
      .eq("store_id", storeId)
      .eq("is_active", true);

    if (!branches || branches.length === 0) return null;
    if (branches.length === 1) return branches[0].id;
    throw Object.assign(
      new Error(
        "Select a branch for this QR code — this store has more than one.",
      ),
      { statusCode: 400 },
    );
  }

  async createStoreQrCode(
    storeId: string,
    data: { label: string; branch_id?: string | null },
  ): Promise<StoreQrCode & { url: string; qr_image: string }> {
    const branchId = await this.resolveQrCodeBranchId(storeId, data.branch_id);
    if (!branchId) {
      throw Object.assign(new Error("No branch found for this store"), {
        statusCode: 400,
      });
    }

    const { data: branch, error: fetchErr } = await this.supabase
      .from("store_branches")
      .select("qr_codes")
      .eq("id", branchId)
      .single();
    if (fetchErr) throw fetchErr;

    const code = crypto.randomBytes(4).toString("hex");
    const newQr: StoreQrCode = {
      id: crypto.randomUUID(),
      store_id: storeId,
      branch_id: branchId,
      label: data.label,
      code,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const existing: any[] = Array.isArray(branch?.qr_codes)
      ? branch.qr_codes
      : [];
    const { error: updateErr } = await this.supabase
      .from("store_branches")
      .update({ qr_codes: [...existing, newQr] })
      .eq("id", branchId);
    if (updateErr) throw updateErr;

    const [withAssets] = await this.attachQrCodeAssets(storeId, [newQr]);
    return withAssets;
  }

  async updateStoreQrCode(
    storeId: string,
    id: string,
    updates: { label?: string; branch_id?: string | null; is_active?: boolean },
  ): Promise<StoreQrCode & { url: string; qr_image: string }> {
    // Find which branch holds this QR code
    const { data: branches, error: fetchErr } = await this.supabase
      .from("store_branches")
      .select("id, qr_codes")
      .eq("store_id", storeId);
    if (fetchErr) throw fetchErr;

    let targetBranch: any = null;
    let targetIdx = -1;
    for (const b of branches || []) {
      const codes: any[] = Array.isArray(b.qr_codes) ? b.qr_codes : [];
      const idx = codes.findIndex((q: any) => q.id === id);
      if (idx !== -1) {
        targetBranch = b;
        targetIdx = idx;
        break;
      }
    }
    if (!targetBranch) {
      throw Object.assign(new Error("QR code not found"), { statusCode: 404 });
    }

    const codes: any[] = [
      ...(Array.isArray(targetBranch.qr_codes) ? targetBranch.qr_codes : []),
    ];
    const updated: StoreQrCode = {
      ...codes[targetIdx],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    codes[targetIdx] = updated;

    const { error: updateErr } = await this.supabase
      .from("store_branches")
      .update({ qr_codes: codes })
      .eq("id", targetBranch.id);
    if (updateErr) throw updateErr;

    const [withAssets] = await this.attachQrCodeAssets(storeId, [updated]);
    return withAssets;
  }

  async deleteStoreQrCode(storeId: string, id: string): Promise<void> {
    const { data: branches, error: fetchErr } = await this.supabase
      .from("store_branches")
      .select("id, qr_codes")
      .eq("store_id", storeId);
    if (fetchErr) throw fetchErr;

    for (const b of branches || []) {
      const codes: any[] = Array.isArray(b.qr_codes) ? b.qr_codes : [];
      if (codes.some((q: any) => q.id === id)) {
        const filtered = codes.filter((q: any) => q.id !== id);
        const { error } = await this.supabase
          .from("store_branches")
          .update({ qr_codes: filtered })
          .eq("id", b.id);
        if (error) throw error;
        return;
      }
    }
  }

  /**
   * Resolves a scanned code to its branch + label — used both by the public
   * pre-checkout endpoint and by resolveStoreCharge, which re-resolves it
   * server-side rather than trusting anything the client sends, the same
   * way modifier prices and branch overrides are always re-resolved.
   */
  private async resolveQrCode(
    storeId: string,
    code: string,
  ): Promise<{ id: string; branch_id: string | null; label: string }> {
    const { data: branches } = await this.supabase
      .from("store_branches")
      .select("id, qr_codes")
      .eq("store_id", storeId);

    for (const b of branches || []) {
      const codes: any[] = Array.isArray(b.qr_codes) ? b.qr_codes : [];
      const match = codes.find(
        (q: any) => q.code === code && q.is_active !== false,
      );
      if (match) return { id: match.id, branch_id: b.id, label: match.label };
    }

    throw Object.assign(
      new Error("This QR code is invalid or no longer active."),
      {
        statusCode: 404,
      },
    );
  }

  async getPublicStoreQrCode(
    slug: string,
    code: string,
  ): Promise<{ branch_id: string | null; label: string }> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const resolved = await this.resolveQrCode(store.id, code);
    return { branch_id: resolved.branch_id, label: resolved.label };
  }

  // ============================================================================
  // Store Menus Management (Food Store — PRD Phase 2)
  // ============================================================================

  async getStoreMenus(
    storeId: string,
  ): Promise<(StoreMenu & { category_count: number; item_count: number })[]> {
    const { data: menuCats, error } = await this.supabase
      .from("store_categories")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_menu", true)
      .order("position", { ascending: true });
    if (error) throw error;

    const menus = menuCats || [];
    if (menus.length === 0) return [];

    const menuIds = menus.map((m: any) => m.id);
    const { data: categories, error: catError } = await this.supabase
      .from("store_categories")
      .select("id, parent_id")
      .eq("store_id", storeId)
      .in("parent_id", menuIds);
    if (catError) throw catError;

    const categoryIds = (categories || []).map((c: any) => c.id);
    let productCategories: Array<{ product_id: string; category_id: string }> =
      [];
    if (categoryIds.length > 0) {
      const { data: pc, error: pcError } = await this.supabase
        .from("product_categories")
        .select("product_id, category_id")
        .in("category_id", categoryIds);
      if (pcError) throw pcError;
      productCategories = pc || [];
    }

    return menus.map((menu: any) => {
      const menuCategoryIds = new Set(
        (categories || [])
          .filter((c: any) => c.parent_id === menu.id)
          .map((c: any) => c.id),
      );
      const itemIds = new Set(
        productCategories
          .filter((pc) => menuCategoryIds.has(pc.category_id))
          .map((pc) => pc.product_id),
      );
      return {
        ...menu,
        category_count: menuCategoryIds.size,
        item_count: itemIds.size,
      };
    });
  }

  async createStoreMenu(
    storeId: string,
    data: Partial<StoreMenu>,
  ): Promise<StoreMenu> {
    const slug = (data.name ?? "menu")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 90);
    const { data: menu, error } = await this.supabase
      .from("store_categories")
      .insert({ ...data, store_id: storeId, is_menu: true, slug })
      .select("*")
      .single();
    if (error) throw error;
    return menu;
  }

  async updateStoreMenu(
    storeId: string,
    menuId: string,
    updates: Partial<StoreMenu>,
  ): Promise<StoreMenu> {
    const { data: menu, error } = await this.supabase
      .from("store_categories")
      .update(updates)
      .eq("id", menuId)
      .eq("store_id", storeId)
      .eq("is_menu", true)
      .select("*")
      .single();
    if (error) throw error;
    return menu;
  }

  async deleteStoreMenu(storeId: string, menuId: string): Promise<void> {
    // Detach child categories before deleting the menu row
    await this.supabase
      .from("store_categories")
      .update({ parent_id: null })
      .eq("store_id", storeId)
      .eq("parent_id", menuId);

    const { error } = await this.supabase
      .from("store_categories")
      .delete()
      .eq("id", menuId)
      .eq("store_id", storeId)
      .eq("is_menu", true);
    if (error) throw error;
  }

  // ============================================================================
  // Units
  // ============================================================================

  async getStoreUnits(
    storeId: string,
    userId: string,
    businessId?: string,
  ): Promise<StoreUnit[]> {
    await this.validateStoreOwnership(storeId, userId, businessId);

    const { data, error } = await this.supabase.rpc(
      "get_units_with_usage",
      { target_store_id: storeId },
    );
    if (error) throw error;
    return (data ?? []).map((unit: StoreUnit) => ({
      ...unit,
      product_count: Number(unit.product_count ?? 0),
    }));
  }

  private async resolveProductUnit(
    value: string,
  ): Promise<Pick<StoreUnit, "id" | "code">> {
    const normalizedValue = value.trim().toLowerCase();
    const { data, error } = await this.supabase
      .from("units")
      .select("id, code, name, symbol")
      .eq("is_active", true);
    if (error) throw error;

    const unit = (data ?? []).find((candidate) =>
      [candidate.code, candidate.name, candidate.symbol]
        .some((candidateValue) => candidateValue.toLowerCase() === normalizedValue),
    );
    if (!unit) {
      throw Object.assign(
        new Error(`Unit "${value}" is not available for this store`),
        { statusCode: 400 },
      );
    }
    return unit;
  }

  // ============================================================================
  // Modifier Groups Management (Food Store — PRD Phase 2)
  // ============================================================================

  async getModifierGroups(
    storeId: string,
    kind?: "modifier" | "addon",
  ): Promise<ModifierGroup[]> {
    let query = this.supabase
      .from("modifier_groups")
      .select(MODIFIER_GROUP_COLUMNS as "*")
      .eq("store_id", storeId)
      .range(0, MODIFIER_GROUP_FETCH_LIMIT - 1);

    if (kind) {
      query = query.eq("kind", kind);
    }

    const { data: groups, error } = await query.order("position", {
      ascending: true,
    });

    if (error) throw error;

    const rows = groups || [];
    const productCounts = await this.getModifierGroupProductCounts(
      rows.map((group) => group.id),
    );
    const optionCounts = await this.getModifierGroupOptionCounts(
      storeId,
      kind,
    );

    return rows.map((group) => ({
      ...group,
      options: [],
      options_count: optionCounts.get(group.id) ?? 0,
      product_count: productCounts.get(group.id) ?? 0,
    }));
  }

  /** Full modifier group (including options) for a single id. */
  async getModifierGroup(
    storeId: string,
    groupId: string,
  ): Promise<ModifierGroup> {
    const { data: group, error } = await this.supabase
      .from("modifier_groups")
      .select(MODIFIER_GROUP_DETAIL_COLUMNS as "*")
      .eq("id", groupId)
      .eq("store_id", storeId)
      .single();

    if (error || !group) {
      throw Object.assign(new Error("Modifier group not found"), {
        statusCode: 404,
      });
    }

    const productCounts = await this.getModifierGroupProductCounts([groupId]);
    return {
      ...group,
      options: Array.isArray(group.options) ? group.options : [],
      product_count: productCounts.get(group.id) ?? 0,
    };
  }

  /**
   * Modifier groups by id, in the id order given, with options included.
   * Used wherever a specific set of groups (not a whole store) is consumed —
   * keeps reads targeted instead of pulling every group for the store.
   */
  private async getModifierGroupsByIds(
    storeId: string,
    groupIds: string[],
  ): Promise<ModifierGroup[]> {
    if (groupIds.length === 0) return [];

    const { data: groups, error } = await this.supabase
      .from("modifier_groups")
      .select(MODIFIER_GROUP_DETAIL_COLUMNS as "*")
      .in("id", groupIds)
      .eq("store_id", storeId);

    if (error) throw error;

    const byId = new Map<string, ModifierGroup>();
    for (const row of groups || []) {
      byId.set(row.id, { ...row, options: row.options ?? [] });
    }

    const productCounts = await this.getModifierGroupProductCounts(groupIds);
    return groupIds.flatMap((groupId) => {
      const group = byId.get(groupId);
      if (!group) return [];
      return [{ ...group, product_count: productCounts.get(groupId) ?? 0 }];
    });
  }

  /**
   * Counts options per group without pulling the option payloads into the
   * list row stream. The JSONB array is small, so the bounded read is cheap.
   */
  private async getModifierGroupOptionCounts(
    storeId: string,
    kind?: "modifier" | "addon",
  ): Promise<Map<string, number>> {
    let query = this.supabase
      .from("modifier_groups")
      .select("id, options")
      .eq("store_id", storeId)
      .range(0, MODIFIER_GROUP_FETCH_LIMIT - 1);

    if (kind) {
      query = query.eq("kind", kind);
    }

    const { data: groups, error } = await query;
    if (error) throw error;

    return (groups || []).reduce((counts, group) => {
      counts.set(
        group.id,
        Array.isArray(group.options) ? group.options.length : 0,
      );
      return counts;
    }, new Map<string, number>());
  }

  private async getModifierGroupProductCounts(
    groupIds: string[],
  ): Promise<Map<string, number>> {
    if (groupIds.length === 0) return new Map();

    const { data: links, error } = await this.supabase
      .from("product_modifier_groups")
      .select("modifier_group_id")
      .in("modifier_group_id", groupIds);

    if (error) throw error;

    return (links || []).reduce((counts, link: { modifier_group_id: string }) => {
      counts.set(
        link.modifier_group_id,
        (counts.get(link.modifier_group_id) ?? 0) + 1,
      );
      return counts;
    }, new Map<string, number>());
  }

  async reorderModifierGroups(
    storeId: string,
    orderedIds: string[],
  ): Promise<void> {
    const { data: groups, error } = await this.supabase
      .from("modifier_groups")
      .select("id")
      .eq("store_id", storeId)
      .in("id", orderedIds);

    if (error) throw error;

    const ownedIds = new Set((groups || []).map((group) => group.id));
    const updates = orderedIds
      .filter((groupId) => ownedIds.has(groupId))
      .map((groupId, position) => ({ id: groupId, position }));

    for (const update of updates) {
      const { error: updateError } = await this.supabase
        .from("modifier_groups")
        .update({ position: update.position })
        .eq("id", update.id)
        .eq("store_id", storeId);
      if (updateError) throw updateError;
    }
  }

  async createModifierGroup(
    storeId: string,
    data: ModifierGroupUpsert,
  ): Promise<ModifierGroup> {
    const { options, ...groupData } = data;
    const insertOptions = this.buildModifierOptions(null, options);

    const { data: group, error } = await this.supabase
      .from("modifier_groups")
      .insert({ ...groupData, store_id: storeId, options: insertOptions })
      .select(MODIFIER_GROUP_COLUMNS as "*")
      .single();

    if (error) throw error;
    return {
      ...group,
      options: insertOptions,
      options_count: insertOptions.length,
      product_count: 0,
    };
  }

  async updateModifierGroup(
    storeId: string,
    groupId: string,
    updates: ModifierGroupUpsert,
  ): Promise<ModifierGroup> {
    const { options, ...groupData } = updates;

    if (options !== undefined) {
      await this.assertModifierGroupOwnership(storeId, groupId);
      await this.replaceModifierGroupOptions(groupId, options);
    }

    const { data: group, error } = await this.supabase
      .from("modifier_groups")
      .update(groupData)
      .eq("id", groupId)
      .eq("store_id", storeId)
      .select(MODIFIER_GROUP_COLUMNS as "*")
      .single();

    if (error) throw error;
    return {
      ...group,
      options: [],
      options_count: await this.countModifierGroupOptions(groupId),
      product_count: 0,
    };
  }

  /**
   * Modifier options are embedded in the group's JSONB `options` array. Accept
   * the whole list on create/update so a group and its options land in one
   * write (and one round-trip) instead of one request per option.
   */
  private buildModifierOptions(
    groupId: string | null,
    options?: Partial<ModifierOption>[],
  ): ModifierOption[] {
    return (options ?? []).map((option, index) =>
      this.buildModifierOption(groupId, option, option.position ?? index),
    );
  }

  private buildModifierOption(
    groupId: string | null,
    data: Partial<ModifierOption>,
    position: number,
  ): ModifierOption {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      modifier_group_id: groupId,
      name: data.name ?? "",
      price_delta: data.price_delta ?? 0,
      is_available: data.is_available ?? true,
      is_default: data.is_default ?? false,
      position,
      branch_ids: data.branch_ids ?? null,
      created_at: now,
      updated_at: now,
    } as ModifierOption;
  }

  private async countModifierGroupOptions(groupId: string): Promise<number> {
    const { data: group, error } = await this.supabase
      .from("modifier_groups")
      .select("options")
      .eq("id", groupId)
      .single();
    if (error) throw error;
    return Array.isArray(group?.options) ? group.options.length : 0;
  }

  private async replaceModifierGroupOptions(
    groupId: string,
    options: Partial<ModifierOption>[],
  ): Promise<void> {
    const built = this.buildModifierOptions(groupId, options);
    const { error } = await this.supabase
      .from("modifier_groups")
      .update({ options: built })
      .eq("id", groupId);
    if (error) throw error;
  }

  async deleteModifierGroup(storeId: string, groupId: string): Promise<void> {
    // product_modifier_groups rows cascade via the modifier_group_id FK.
    const { error } = await this.supabase
      .from("modifier_groups")
      .delete()
      .eq("id", groupId)
      .eq("store_id", storeId);

    if (error) throw error;
  }

  /**
   * Modifier options belong to a group, not directly to a store — verify
   * the group is owned by this store before touching its options.
   */
  private async assertModifierGroupOwnership(
    storeId: string,
    groupId: string,
  ): Promise<void> {
    const { data: group, error } = await this.supabase
      .from("modifier_groups")
      .select("id")
      .eq("id", groupId)
      .eq("store_id", storeId)
      .single();

    if (error || !group) {
      throw Object.assign(new Error("Modifier group not found"), {
        statusCode: 404,
      });
    }
  }

  async createModifierOption(
    storeId: string,
    groupId: string,
    data: Partial<ModifierOption>,
  ): Promise<ModifierOption> {
    await this.assertModifierGroupOwnership(storeId, groupId);

    const { data: group, error: fetchErr } = await this.supabase
      .from("modifier_groups")
      .select("options")
      .eq("id", groupId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentOptions: ModifierOption[] = Array.isArray(group?.options)
      ? group.options
      : [];
    const newOption = this.buildModifierOption(
      groupId,
      data,
      data.position ?? currentOptions.length,
    );

    const { error: updateErr } = await this.supabase
      .from("modifier_groups")
      .update({ options: [...currentOptions, newOption] })
      .eq("id", groupId);
    if (updateErr) throw updateErr;

    return newOption;
  }

  async updateModifierOption(
    storeId: string,
    groupId: string,
    optionId: string,
    updates: Partial<ModifierOption>,
  ): Promise<ModifierOption> {
    await this.assertModifierGroupOwnership(storeId, groupId);

    const { data: group, error: fetchErr } = await this.supabase
      .from("modifier_groups")
      .select("options")
      .eq("id", groupId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentOptions: any[] = Array.isArray(group?.options)
      ? group.options
      : [];
    const idx = currentOptions.findIndex((o: any) => o.id === optionId);
    if (idx === -1) {
      throw Object.assign(new Error("Modifier option not found"), {
        statusCode: 404,
      });
    }

    const updated = {
      ...currentOptions[idx],
      ...updates,
      id: optionId,
      modifier_group_id: groupId,
      updated_at: new Date().toISOString(),
    };
    currentOptions[idx] = updated;

    const { error: updateErr } = await this.supabase
      .from("modifier_groups")
      .update({ options: currentOptions })
      .eq("id", groupId);
    if (updateErr) throw updateErr;

    return updated as ModifierOption;
  }

  async deleteModifierOption(
    storeId: string,
    groupId: string,
    optionId: string,
  ): Promise<void> {
    await this.assertModifierGroupOwnership(storeId, groupId);

    const { data: group, error: fetchErr } = await this.supabase
      .from("modifier_groups")
      .select("options")
      .eq("id", groupId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentOptions: any[] = Array.isArray(group?.options)
      ? group.options
      : [];
    const filtered = currentOptions.filter((o: any) => o.id !== optionId);

    const { error: updateErr } = await this.supabase
      .from("modifier_groups")
      .update({ options: filtered })
      .eq("id", groupId);
    if (updateErr) throw updateErr;
  }

  /** Applies a full order for a group's options, preserving ownership scope. */
  async reorderModifierOptions(
    storeId: string,
    groupId: string,
    orderedIds: string[],
  ): Promise<void> {
    await this.assertModifierGroupOwnership(storeId, groupId);

    const { data: group, error: fetchErr } = await this.supabase
      .from("modifier_groups")
      .select("options")
      .eq("id", groupId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentOptions: ModifierOption[] = Array.isArray(group?.options)
      ? group.options
      : [];
    const byId = new Map(currentOptions.map((option) => [option.id, option]));

    const reordered = orderedIds.flatMap((optionId, position) => {
      const option = byId.get(optionId);
      if (!option) return [];
      return [{ ...option, position }];
    });

    const { error: updateErr } = await this.supabase
      .from("modifier_groups")
      .update({ options: reordered })
      .eq("id", groupId);
    if (updateErr) throw updateErr;
  }

  /**
   * Attach a reusable modifier group to a product (junction table).
   */
  async attachModifierGroupToProduct(
    storeId: string,
    productId: string,
    modifierGroupId: string,
    position?: number,
  ): Promise<void> {
    const { data: product, error: productError } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (productError || !product) {
      throw Object.assign(new Error("Product not found"), {
        statusCode: 404,
      });
    }

    await this.assertModifierGroupOwnership(storeId, modifierGroupId);

    const { error } = await this.supabase
      .from("product_modifier_groups")
      .upsert(
        {
          product_id: productId,
          modifier_group_id: modifierGroupId,
          position: position ?? 0,
        },
        { onConflict: "product_id,modifier_group_id" },
      );

    if (error) throw error;
  }

  async detachModifierGroupFromProduct(
    productId: string,
    modifierGroupId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("product_modifier_groups")
      .delete()
      .eq("product_id", productId)
      .eq("modifier_group_id", modifierGroupId);

    if (error) throw error;
  }

  async getProductModifierGroups(
    storeId: string,
    productId: string,
  ): Promise<ModifierGroup[]> {
    const { data: links, error } = await this.supabase
      .from("product_modifier_groups")
      .select("modifier_group_id, position")
      .eq("product_id", productId)
      .order("position", { ascending: true });

    if (error) throw error;

    const groupIds = (links || []).map((link) => link.modifier_group_id);
    return this.getModifierGroupsByIds(storeId, groupIds);
  }

  /**
   * Resolves a checkout item's selected modifiers/add-ons against the
   * product's actually-attached groups — validates ownership and
   * availability server-side (never trust client-sent prices/ids), enforces
   * each attached group's min/max selection rules, and returns the total
   * price delta plus enriched entries for order storage. Shared by all
   * checkout paths (card, bank transfer, free purchase).
   */
  async resolveSelectedModifiers(
    productId: string,
    selectedModifiers?: Array<{
      modifier_option_id: string;
      quantity?: number;
    }>,
    branchId?: string | null,
  ): Promise<{
    priceDelta: number;
    resolved: Array<{
      modifier_option_id: string;
      modifier_group_id: string;
      name: string;
      price_delta: number;
      quantity: number;
    }>;
  }> {
    if (!selectedModifiers || selectedModifiers.length === 0) {
      return { priceDelta: 0, resolved: [] };
    }

    const { data: links, error: linksError } = await this.supabase
      .from("product_modifier_groups")
      .select("modifier_group_id")
      .eq("product_id", productId);
    if (linksError) throw linksError;

    const attachedGroupIds = new Set(
      (links || []).map((link) => link.modifier_group_id),
    );
    if (attachedGroupIds.size === 0) {
      throw Object.assign(new Error("This item has no modifiers to select"), {
        statusCode: 400,
      });
    }

    const optionIds = new Set(
      selectedModifiers.map((m) => m.modifier_option_id),
    );
    // Fetch all groups attached to this product and flatten their options
    const { data: allGroups, error: groupsError } = await this.supabase
      .from("modifier_groups")
      .select("id, options")
      .in("id", [...attachedGroupIds]);
    if (groupsError) throw groupsError;

    const optionById = new Map<string, any>();
    for (const grp of allGroups || []) {
      for (const opt of Array.isArray(grp.options) ? grp.options : []) {
        if (optionIds.has(opt.id)) {
          optionById.set(opt.id, { ...opt, modifier_group_id: grp.id });
        }
      }
    }
    const selectedCountByGroup = new Map<string, number>();
    let priceDelta = 0;
    const resolved: Array<{
      modifier_option_id: string;
      modifier_group_id: string;
      name: string;
      price_delta: number;
      quantity: number;
    }> = [];

    for (const sel of selectedModifiers) {
      const option = optionById.get(sel.modifier_option_id);
      if (!option) {
        throw Object.assign(
          new Error(`Modifier option not found: ${sel.modifier_option_id}`),
          { statusCode: 400 },
        );
      }
      if (!attachedGroupIds.has(option.modifier_group_id)) {
        throw Object.assign(
          new Error(`"${option.name}" is not available for this item`),
          { statusCode: 400 },
        );
      }
      if (!option.is_available) {
        throw Object.assign(
          new Error(`"${option.name}" is currently unavailable`),
          { statusCode: 400 },
        );
      }
      if (
        branchId &&
        option.branch_ids &&
        !option.branch_ids.includes(branchId)
      ) {
        throw Object.assign(
          new Error(`"${option.name}" is not available for this item`),
          { statusCode: 400 },
        );
      }

      const quantity = sel.quantity && sel.quantity > 0 ? sel.quantity : 1;
      priceDelta += option.price_delta * quantity;
      resolved.push({
        modifier_option_id: option.id,
        modifier_group_id: option.modifier_group_id,
        name: option.name,
        price_delta: option.price_delta,
        quantity,
      });
      selectedCountByGroup.set(
        option.modifier_group_id,
        (selectedCountByGroup.get(option.modifier_group_id) || 0) + 1,
      );
    }

    const { data: groups, error: groupRulesError } = await this.supabase
      .from("modifier_groups")
      .select("id, name, min_selections, max_selections, branch_ids")
      .in("id", Array.from(attachedGroupIds));
    if (groupRulesError) throw groupRulesError;

    for (const group of groups || []) {
      const count = selectedCountByGroup.get(group.id) || 0;
      if (
        count > 0 &&
        branchId &&
        group.branch_ids &&
        !group.branch_ids.includes(branchId)
      ) {
        throw Object.assign(
          new Error(`"${group.name}" is not available at this branch`),
          { statusCode: 400 },
        );
      }
      if (count < group.min_selections) {
        throw Object.assign(
          new Error(
            `"${group.name}" requires at least ${group.min_selections} selection(s)`,
          ),
          { statusCode: 400 },
        );
      }
      if (group.max_selections != null && count > group.max_selections) {
        throw Object.assign(
          new Error(
            `"${group.name}" allows at most ${group.max_selections} selection(s)`,
          ),
          { statusCode: 400 },
        );
      }
    }

    return { priceDelta, resolved };
  }

  // ============================================================================
  // Delivery Methods Management
  // ============================================================================

  /**
   * Get all delivery methods for a store
   */
  /**
   * Load a store's business pickup address (the Shipbubble sender). Returned
   * fields mirror what getPublicDeliveryRates uses to build the sender.
   */
  async getStoreSenderAddress(storeId: string): Promise<{
    businessId?: string;
    name?: string;
    phone?: string;
    email?: string;
    address?: string;
    address_code?: number;
  } | null> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", storeId)
      .single();

    if (!store?.business_id) return null;

    const { data: business } = await this.supabase
      .from("businesses")
      .select("name, address")
      .eq("id", store.business_id)
      .single();

    if (!business) return null;

    const addr = (business.address as any) || {};
    return {
      businessId: store.business_id,
      name: business.name || undefined,
      phone: addr.phone || undefined,
      email: addr.email || undefined,
      address: addr.street
        ? `${addr.street}, ${addr.city || ""}, ${addr.state || ""}, ${addr.country || "Nigeria"}`
        : undefined,
      address_code:
        typeof addr.shipbubble_address_code === "number"
          ? addr.shipbubble_address_code
          : undefined,
    };
  }

  /**
   * Cache a validated Shipbubble sender address_code on the business address
   * so future rate/label calls reuse it instead of re-validating.
   */
  async saveSenderAddressCode(
    businessId: string,
    addressCode: number,
  ): Promise<void> {
    const { data: business } = await this.supabase
      .from("businesses")
      .select("address")
      .eq("id", businessId)
      .single();

    const address = {
      ...((business?.address as any) || {}),
      shipbubble_address_code: addressCode,
    };

    const { error } = await this.supabase
      .from("businesses")
      .update({ address })
      .eq("id", businessId);

    if (error) throw error;
  }

  /**
   * Enable/disable carrier (Shipbubble) delivery for a store.
   */
  async setCarrierDelivery(storeId: string, enabled: boolean): Promise<void> {
    const { error } = await this.supabase
      .from("stores")
      .update({ carrier_delivery_enabled: enabled })
      .eq("id", storeId);

    if (error) throw error;
  }

  async getDeliveryMethods(storeId: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      price: number;
      currency: string;
      estimated_time: string | null;
      is_active: boolean;
      sort_order: number;
      created_at: string;
    }>
  > {
    const { data, error } = await this.supabase
      .from("store_delivery_methods")
      .select("*")
      .eq("store_id", storeId)
      .or("is_zone.is.null,is_zone.eq.false")
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a new delivery method
   */
  async createDeliveryMethod(
    storeId: string,
    data: {
      name: string;
      description?: string;
      price?: number;
      currency?: string;
      estimated_time?: string;
      is_active?: boolean;
      sort_order?: number;
    },
  ): Promise<{
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    estimated_time: string | null;
    is_active: boolean;
    sort_order: number;
  }> {
    // Get max sort_order if not provided
    let sortOrder = data.sort_order;
    if (sortOrder === undefined) {
      const { data: maxOrder } = await this.supabase
        .from("store_delivery_methods")
        .select("sort_order")
        .eq("store_id", storeId)
        .order("sort_order", { ascending: false })
        .limit(1)
        .single();
      sortOrder = (maxOrder?.sort_order || 0) + 1;
    }

    const { data: method, error } = await this.supabase
      .from("store_delivery_methods")
      .insert([
        {
          store_id: storeId,
          name: data.name,
          description: data.description || null,
          price: data.price || 0,
          currency: data.currency || "NGN",
          estimated_time: data.estimated_time || null,
          is_active: data.is_active !== false,
          sort_order: sortOrder,
        },
      ])
      .select("*")
      .single();

    if (error) {
      console.error("Error creating delivery method:", error);
      throw error;
    }
    return method;
  }

  /**
   * Update a delivery method
   */
  async updateDeliveryMethod(
    storeId: string,
    methodId: string,
    updates: {
      name?: string;
      description?: string | null;
      price?: number;
      currency?: string;
      estimated_time?: string | null;
      is_active?: boolean;
      sort_order?: number;
    },
  ): Promise<{
    id: string;
    name: string;
    description: string | null;
    price: number;
    currency: string;
    estimated_time: string | null;
    is_active: boolean;
    sort_order: number;
  }> {
    // Verify method belongs to store
    const { data: existing } = await this.supabase
      .from("store_delivery_methods")
      .select("id")
      .eq("id", methodId)
      .eq("store_id", storeId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Delivery method not found"), {
        statusCode: 404,
      });
    }

    const { data: method, error } = await this.supabase
      .from("store_delivery_methods")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", methodId)
      .select("*")
      .single();

    if (error) throw error;
    return method;
  }

  /**
   * Delete a delivery method (soft delete by setting is_active = false)
   */
  async deleteDeliveryMethod(storeId: string, methodId: string): Promise<void> {
    // Verify method belongs to store
    const { data: existing } = await this.supabase
      .from("store_delivery_methods")
      .select("id")
      .eq("id", methodId)
      .eq("store_id", storeId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Delivery method not found"), {
        statusCode: 404,
      });
    }

    // Soft delete - set is_active to false
    const { error } = await this.supabase
      .from("store_delivery_methods")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", methodId);

    if (error) throw error;
  }

  /**
   * Reorder delivery methods
   */
  async reorderDeliveryMethods(
    storeId: string,
    order: string[],
  ): Promise<void> {
    // Verify all methods belong to store
    const { data: existing } = await this.supabase
      .from("store_delivery_methods")
      .select("id")
      .eq("store_id", storeId)
      .in("id", order);

    if (!existing || existing.length !== order.length) {
      throw Object.assign(new Error("One or more delivery methods not found"), {
        statusCode: 404,
      });
    }

    // Update sort_order for each
    for (let i = 0; i < order.length; i++) {
      await this.supabase
        .from("store_delivery_methods")
        .update({ sort_order: i, updated_at: new Date().toISOString() })
        .eq("id", order[i]);
    }
  }

  /**
   * Get active delivery methods for public storefront
   */
  async getPublicDeliveryMethods(slug: string): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      price: number;
      currency: string;
      estimated_time: string | null;
    }>
  > {
    // Get store by slug
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const { data, error } = await this.supabase
      .from("store_delivery_methods")
      .select("id, name, description, price, currency, estimated_time")
      .eq("store_id", store.id)
      .eq("is_active", true)
      // Flat-rate methods only — zone rows (is_zone = true) are matched
      // separately by zip via getPublicDeliveryZoneMatch/matchDeliveryZone,
      // never listed as a manually-pickable method (they'd fail
      // validateDeliveryMethod server-side, silently zeroing the fee).
      .or("is_zone.is.null,is_zone.eq.false")
      .order("sort_order", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Public zip → zone fee preview for checkout, ahead of payment. Reuses
   * matchDeliveryZone verbatim so the preview can never disagree with what
   * resolveStoreCharge actually charges for the same branch_id + zip.
   */
  async getPublicDeliveryZoneMatch(
    slug: string,
    branchId: string,
    zip: string,
  ): Promise<{
    fee: number;
    min_order: number | null;
    estimated_minutes: number | null;
  } | null> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    return this.matchDeliveryZone(store.id, branchId, zip);
  }

  // ============================================================================
  // Delivery Integrations
  // ============================================================================

  /**
   * Get delivery integrations for a store
   */
  async getDeliveryIntegrations(storeId: string): Promise<
    Array<{
      id: string;
      provider: string;
      is_enabled: boolean;
      config: Record<string, any>;
      created_at: string;
    }>
  > {
    const { data, error } = await this.supabase
      .from("store_delivery_integrations")
      .select("id, provider, is_enabled, config, created_at")
      .eq("store_id", storeId);

    if (error) throw error;

    const providers = ["gig", "kwik", "dhl", "sendbox"];
    const integrations = data || [];

    return providers.map((provider) => {
      const existing = integrations.find((i) => i.provider === provider);
      return (
        existing || {
          id: "",
          provider,
          is_enabled: false,
          config: {} as Record<string, any>,
          created_at: "",
        }
      );
    });
  }

  /**
   * Toggle a delivery integration
   */
  async toggleDeliveryIntegration(
    storeId: string,
    provider: string,
    isEnabled: boolean,
    config?: Record<string, any>,
  ): Promise<{ provider: string; is_enabled: boolean }> {
    const upsertData: Record<string, any> = {
      store_id: storeId,
      provider,
      is_enabled: isEnabled,
      updated_at: new Date().toISOString(),
    };

    if (config !== undefined) {
      upsertData.config = config;
    }

    const { data, error } = await this.supabase
      .from("store_delivery_integrations")
      .upsert(upsertData, {
        onConflict: "store_id,provider",
      })
      .select("provider, is_enabled")
      .single();

    if (error) throw error;
    return data;
  }

  async updateDeliveryIntegrationConfig(
    storeId: string,
    provider: string,
    config: Record<string, any>,
  ): Promise<{ provider: string; config: Record<string, any> }> {
    const { data, error } = await this.supabase
      .from("store_delivery_integrations")
      .upsert(
        {
          store_id: storeId,
          provider,
          config,
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "store_id,provider",
        },
      )
      .select("provider, config")
      .single();

    if (error) throw error;
    return {
      provider: data.provider,
      config: (data.config as Record<string, any>) || {},
    };
  }

  async getStoreIdBySlug(slug: string): Promise<string | null> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    return store?.id || null;
  }

  /**
   * Validate delivery method for order
   */
  async validateDeliveryMethod(
    storeId: string,
    methodId: string,
  ): Promise<{
    id: string;
    name: string;
    price: number;
    currency: string;
  } | null> {
    const { data } = await this.supabase
      .from("store_delivery_methods")
      .select("id, name, price, currency")
      .eq("id", methodId)
      .eq("store_id", storeId)
      .eq("is_active", true)
      .or("is_zone.is.null,is_zone.eq.false")
      .single();

    return data;
  }

  // ============================================================================
  // Delivery Zones (Branch-Aware Storefront) — merchant-defined,
  // zip-code-keyed fee/minimum-order/ETA tables per branch. Sibling to the
  // flat-rate store_delivery_methods above and orthogonal to the Shipbubble
  // live-courier integration. Tried first at checkout when a branch + zip
  // are known, before falling back to delivery_method_id / client fee.
  // ============================================================================

  // The 20260729 table-collapse migration folded store_delivery_zones into
  // store_delivery_methods (is_zone = true) but only carried the *value*
  // over into that table's existing `price` column — it never added a
  // `fee` column. The public API (schema, controller, frontend) has always
  // spoken in terms of `fee` for a zone, so these methods translate at the
  // boundary: `fee` -> `price` going into a write, `price` -> `fee` coming
  // back out of a read. Without this, every zone write 500'd with "Column
  // 'fee' of relation 'store_delivery_methods' does not exist".
  private toZoneRow(zone: any): any {
    if (!zone) return zone;
    const { price, ...rest } = zone;
    return { ...rest, fee: price };
  }

  async getStoreDeliveryZones(
    storeId: string,
    branchId?: string,
  ): Promise<any[]> {
    let query = this.supabase
      .from("store_delivery_methods")
      .select("*")
      .eq("store_id", storeId)
      .eq("is_zone", true)
      .order("zip_code", { ascending: true });
    if (branchId) query = query.eq("branch_id", branchId);

    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map((z) => this.toZoneRow(z));
  }

  async createStoreDeliveryZone(storeId: string, data: any): Promise<any> {
    const { fee, ...rest } = data;
    const { data: zone, error } = await this.supabase
      .from("store_delivery_methods")
      // `name` is NOT NULL on the shared table (real delivery methods need
      // one) but a zone never had a name field — the collapse migration's
      // own backfill used the zip code as a label-only stand-in, so this
      // matches that exact fallback rather than inventing a new one.
      .insert({ ...rest, name: rest.zip_code || "Zone", price: fee, store_id: storeId, is_zone: true })
      .select("*")
      .single();
    if (error) throw error;
    return this.toZoneRow(zone);
  }

  async updateStoreDeliveryZone(
    storeId: string,
    zoneId: string,
    updates: any,
  ): Promise<any> {
    const { fee, ...rest } = updates;
    const dbUpdates: Record<string, any> = fee !== undefined ? { ...rest, price: fee } : rest;
    if (dbUpdates.zip_code) dbUpdates.name = dbUpdates.zip_code;
    const { data: zone, error } = await this.supabase
      .from("store_delivery_methods")
      .update(dbUpdates)
      .eq("id", zoneId)
      .eq("store_id", storeId)
      .eq("is_zone", true)
      .select("*")
      .single();
    if (error) throw error;
    return this.toZoneRow(zone);
  }

  async deleteStoreDeliveryZone(
    storeId: string,
    zoneId: string,
  ): Promise<void> {
    const { error } = await this.supabase
      .from("store_delivery_methods")
      .delete()
      .eq("id", zoneId)
      .eq("store_id", storeId)
      .eq("is_zone", true);
    if (error) throw error;
  }

  /**
   * Match a customer's zip code against a branch's delivery zones. Returns
   * null if no zone (or no active zone) matches — callers should fall back
   * to delivery_method_id / client-sent delivery_fee.
   */
  async matchDeliveryZone(
    storeId: string,
    branchId: string,
    zip: string,
  ): Promise<{
    fee: number;
    min_order: number | null;
    estimated_minutes: number | null;
  } | null> {
    const { data } = await this.supabase
      .from("store_delivery_methods")
      .select("price, min_order, estimated_minutes")
      .eq("store_id", storeId)
      .eq("branch_id", branchId)
      .eq("zip_code", zip)
      .eq("is_zone", true)
      .eq("is_active", true)
      .maybeSingle();

    if (!data) return null;
    return {
      fee: data.price,
      min_order: data.min_order,
      estimated_minutes: data.estimated_minutes,
    };
  }

  /**
   * Rejects checkout if the selected branch has temporarily paused
   * ordering (accepting_orders = false) — distinct from is_active, which
   * would already exclude the branch from the public branches list
   * entirely.
   */
  private async assertBranchAcceptingOrders(branchId: string): Promise<void> {
    const { data } = await this.supabase
      .from("store_branches")
      .select("name, accepting_orders")
      .eq("id", branchId)
      .single();
    if (data && data.accepting_orders === false) {
      throw Object.assign(
        new Error(
          `"${data.name}" isn't accepting orders right now — please try another location or check back later.`,
        ),
        { statusCode: 400 },
      );
    }
  }

  /**
   * Rejects an item that requires advance notice (e.g. a 48h bulk catering
   * order) if the customer didn't provide a requested date/time, or gave
   * one that's sooner than the product's lead_time_hours from now. Reuses
   * the same slot shape as service bookings (date/startTime/endTime),
   * repurposed here as a plain "requested for" timestamp rather than a
   * scheduled service appointment.
   *
   * slot.date/startTime are always UTC components (the frontend converts
   * the buyer's local wall-clock pick to UTC before sending) — parsed here
   * with an explicit "Z" so this is deterministic regardless of what
   * timezone this server process happens to be running in. Parsing without
   * a zone suffix would silently interpret the string in the server's own
   * local time, which has nothing to do with the buyer's or is arbitrary
   * per-deployment — that was a real, previously-undetected bug here.
   */
  private assertLeadTimeMet(
    productName: string,
    leadTimeHours: number,
    slot?: { date: string; startTime: string } | null,
  ): void {
    if (!slot?.date || !slot?.startTime) {
      throw Object.assign(
        new Error(
          `"${productName}" requires at least ${leadTimeHours} hour(s) advance notice — please select a requested date/time.`,
        ),
        { statusCode: 400 },
      );
    }
    const requestedFor = new Date(`${slot.date}T${slot.startTime}:00Z`);
    if (Number.isNaN(requestedFor.getTime())) {
      throw Object.assign(
        new Error(`"${productName}": invalid requested date/time.`),
        { statusCode: 400 },
      );
    }
    const minAllowed = new Date(Date.now() + leadTimeHours * 60 * 60 * 1000);
    if (requestedFor < minAllowed) {
      throw Object.assign(
        new Error(
          `"${productName}" requires at least ${leadTimeHours} hour(s) advance notice — the earliest you can request is ${minAllowed.toISOString()}.`,
        ),
        { statusCode: 400 },
      );
    }
  }

  // How long a confirmed lead-time validation stays trusted. Generous
  // enough to survive any normal POS checkout (picking modifiers,
  // quantity, walking to the register) or a cart saved mid-shift and
  // resumed later, short enough that a cart resumed days later gets
  // honestly re-checked against real availability rather than trusting a
  // stale confirmation.
  private static readonly LEAD_TIME_VALIDATION_FRESHNESS_MS =
    4 * 60 * 60 * 1000;

  /**
   * Same rule as assertLeadTimeMet, but checked once per distinct
   * product+variant+branch+requested-time and trusted from then on rather
   * than re-derived against a moving "now" every time the ticket is
   * repriced. Without this, a slot picked at the earliest valid minute is
   * booby-trapped: resolveOrderItemPricing runs on every ticket edit (POS
   * preview debounces on every change) and again at charge, so any real
   * time spent building the ticket eats into a margin that was zero to
   * begin with, and a previously-valid slot silently starts failing later
   * in the same session. Caching the confirmation removes the race
   * entirely — the slot is validated against real time exactly once, and
   * that confirmation is durable for the rest of a normal session.
   */
  private async assertLeadTimeMetCached(
    storeId: string,
    productName: string,
    productId: string,
    variantId: string | null,
    branchId: string | null,
    leadTimeHours: number,
    slot?: { date: string; startTime: string } | null,
  ): Promise<void> {
    if (!slot?.date || !slot?.startTime) {
      // No slot at all can never be cached — reuse the plain check purely
      // for its error message.
      this.assertLeadTimeMet(productName, leadTimeHours, slot);
      return;
    }

    let query = supabaseAdmin
      .from("pos_lead_time_validations")
      .select("validated_at")
      .eq("product_id", productId)
      .eq("slot_date", slot.date)
      .eq("slot_start_time", slot.startTime);
    query = variantId
      ? query.eq("variant_id", variantId)
      : query.is("variant_id", null);
    query = branchId
      ? query.eq("branch_id", branchId)
      : query.is("branch_id", null);
    const { data: existing } = await query.maybeSingle();

    if (existing) {
      const age = Date.now() - new Date(existing.validated_at).getTime();
      if (age <= StoreService.LEAD_TIME_VALIDATION_FRESHNESS_MS) return;
    }

    // No cached confirmation, or it's gone stale — check against the real
    // clock, exactly as before. Throws (and skips the write below) if the
    // slot genuinely doesn't satisfy the rule.
    this.assertLeadTimeMet(productName, leadTimeHours, slot);

    // Passed: record it so re-pricing this same ticket later doesn't race
    // the clock for a slot that's already been confirmed valid. Delete any
    // prior (now-superseded) row for this exact key first — same filters as
    // the lookup above — rather than leaving stale duplicates behind.
    let deleteQuery = supabaseAdmin
      .from("pos_lead_time_validations")
      .delete()
      .eq("product_id", productId)
      .eq("slot_date", slot.date)
      .eq("slot_start_time", slot.startTime);
    deleteQuery = variantId
      ? deleteQuery.eq("variant_id", variantId)
      : deleteQuery.is("variant_id", null);
    deleteQuery = branchId
      ? deleteQuery.eq("branch_id", branchId)
      : deleteQuery.is("branch_id", null);
    await deleteQuery;
    await supabaseAdmin.from("pos_lead_time_validations").insert({
      store_id: storeId,
      product_id: productId,
      variant_id: variantId,
      branch_id: branchId,
      slot_date: slot.date,
      slot_start_time: slot.startTime,
    });
  }

  /**
   * min_order_quantity/max_order_quantity/quantity_step are stored on the
   * product but, until now, were never enforced anywhere — a customer could
   * order any quantity regardless of what the merchant configured.
   */
  private assertQuantityConstraints(
    productName: string,
    quantity: number,
    constraints: {
      min_order_quantity?: number | null;
      max_order_quantity?: number | null;
      quantity_step?: number | null;
    },
  ): void {
    const min = constraints.min_order_quantity ?? 1;
    const max = constraints.max_order_quantity ?? null;
    const step = constraints.quantity_step ?? 1;

    if (quantity < min) {
      throw Object.assign(
        new Error(
          `"${productName}" requires a minimum order quantity of ${min}.`,
        ),
        { statusCode: 400 },
      );
    }
    if (max != null && quantity > max) {
      throw Object.assign(
        new Error(`"${productName}" has a maximum order quantity of ${max}.`),
        { statusCode: 400 },
      );
    }
    if (step > 0) {
      const stepsFromMin = (quantity - min) / step;
      if (Math.abs(stepsFromMin - Math.round(stepsFromMin)) > 1e-6) {
        throw Object.assign(
          new Error(
            `"${productName}" must be ordered in increments of ${step}, starting from ${min}.`,
          ),
          { statusCode: 400 },
        );
      }
    }
  }

  /** Sales tax percentage configured on a branch (0 if unset/branch missing). */
  async resolveBranchTaxRate(branchId: string): Promise<number> {
    const { data } = await this.supabase
      .from("store_branches")
      .select("tax_rate")
      .eq("id", branchId)
      .single();
    return data?.tax_rate || 0;
  }

  /**
   * Additional percentage configured on a branch for a specific fulfilment
   * type (e.g. a dine-in-only service charge on top of tax). 0 if unset.
   */
  async resolveBranchServiceChargeRate(
    branchId: string,
    fulfillmentType?: "dine_in" | "pickup" | "delivery" | "curbside",
  ): Promise<number> {
    if (!fulfillmentType) return 0;
    const { data } = await this.supabase
      .from("store_branches")
      .select("service_charge_rates")
      .eq("id", branchId)
      .single();
    return data?.service_charge_rates?.[fulfillmentType] || 0;
  }

  // ============================================================================
  // Store Reviews
  // ============================================================================

  /**
   * Get public store info including reviews summary
   */
  async getPublicStoreInfo(
    slug: string,
    branchId?: string,
  ): Promise<{
    name: string;
    description: string;
    cover_image: string | null;
    logo: string | null;
    accent_color: string;
    availability_profile_id: string | null;
    policies: any;
    contact: {
      email: string | null;
      phone: string | null;
      location: string | null;
      website: string | null;
      social_links: any;
    };
    business_hours: any;
    reviews_summary: {
      average_rating: number;
      total_count: number;
      recent_reviews: any[];
    };
    categories: Array<{
      id: string;
      name: string;
      slug: string;
      product_count: number;
    }>;
  }> {
    // Get store
    const { data: store, error } = await this.supabase
      .from("stores")
      .select("id, name, appearance")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (error || !store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const appearance = store.appearance || {};

    // Multi-branch food stores generally don't have store-level contact/
    // hours filled in — that data lives per-branch instead (store_branches.
    // phone/address/business_hours). Fall back to the customer's selected
    // branch, or the default branch, so the public info drawer isn't blank
    // for those stores when appearance fields were never set.
    const { data: branches } = await this.supabase
      .from("store_branches")
      .select("id, phone, address, business_hours, is_default")
      .eq("store_id", store.id)
      .eq("is_active", true);

    const fallbackBranch =
      (branchId && branches?.find((b) => b.id === branchId)) ||
      branches?.find((b) => b.is_default) ||
      branches?.[0] ||
      null;

    const formatBranchAddress = (address: any): string | null => {
      if (!address) return null;
      const parts = [address.street, address.city, address.state].filter(
        Boolean,
      );
      return parts.length > 0 ? parts.join(", ") : null;
    };

    // Branch hours support multiple ranges per day (BranchDayHoursSchema) but
    // this reads the raw column, which may still hold the legacy single-
    // range shape ({open,close}) rather than the normalized array — the
    // array-wrapping only happens when data passes through that Zod schema.
    // Accept both; the public info drawer only shows one range per day.
    const branchHoursToStoreHours = (hours: any): any => {
      if (!hours) return null;
      const days = [
        "monday",
        "tuesday",
        "wednesday",
        "thursday",
        "friday",
        "saturday",
        "sunday",
      ];
      const result: Record<string, { open: string; close: string } | null> = {};
      for (const day of days) {
        const val = hours[day];
        if (!val) {
          result[day] = null;
        } else {
          result[day] = Array.isArray(val) ? (val[0] ?? null) : val;
        }
      }
      return result;
    };

    const appearanceHasHours =
      appearance.business_hours &&
      Object.values(appearance.business_hours).some((h: any) => h != null);

    // Get reviews summary
    const { data: reviews } = await this.supabase
      .from("store_reviews")
      .select("id, customer_name, rating, content, product_id, created_at")
      .eq("store_id", store.id)
      .eq("is_visible", true)
      .order("created_at", { ascending: false })
      .limit(5);

    // Calculate average rating
    const { data: allReviews } = await this.supabase
      .from("store_reviews")
      .select("rating")
      .eq("store_id", store.id)
      .eq("is_visible", true);

    const totalCount = allReviews?.length || 0;
    const averageRating =
      totalCount > 0
        ? allReviews!.reduce((sum, r) => sum + r.rating, 0) / totalCount
        : 0;

    // Get product info for recent reviews
    const recentReviews = [];
    for (const review of reviews || []) {
      let productName = null;
      let productImage = null;
      if (review.product_id) {
        const { data: product } = await this.supabase
          .from("products")
          .select("name, cover_image")
          .eq("id", review.product_id)
          .single();
        productName = product?.name;
        productImage = product?.cover_image;
      }
      recentReviews.push({
        id: review.id,
        customer_name: review.customer_name,
        rating: review.rating,
        content: review.content,
        product_name: productName,
        product_image: productImage,
        created_at: review.created_at,
      });
    }

    // Get categories
    const categories = await this.getPublicCategories(store.id);

    return {
      name: store.name,
      description: appearance.description || "",
      cover_image: appearance.cover_image || null,
      logo: appearance.logo || null,
      accent_color: appearance.accent_color || "#000000",
      availability_profile_id: appearance.availability_profile_id || null,
      policies: appearance.policies || {},
      contact: {
        email: appearance.contact_email || null,
        phone: appearance.contact_phone || fallbackBranch?.phone || null,
        location:
          appearance.location ||
          formatBranchAddress(fallbackBranch?.address) ||
          null,
        website: appearance.website || null,
        social_links: appearance.social_links || {},
      },
      business_hours: appearanceHasHours
        ? appearance.business_hours
        : branchHoursToStoreHours(fallbackBranch?.business_hours),
      reviews_summary: {
        average_rating: averageRating,
        total_count: totalCount,
        recent_reviews: recentReviews || [],
      },
      categories: categories || [],
    };
  }

  /**
   * Get public reviews for a store (optionally filtered by product)
   */
  async getPublicReviews(
    slug: string,
    page: number,
    limit: number,
    productId?: string,
  ): Promise<{
    data: any[];
    meta: { total: number; page: number; limit: number; totalPages: number };
    summary: { average_rating: number; total_count: number };
  }> {
    // Get store
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const offset = (page - 1) * limit;

    // Build query with optional product filter
    let query = this.supabase
      .from("store_reviews")
      .select(
        "id, customer_name, rating, title, content, product_id, is_verified, created_at",
        { count: "exact" },
      )
      .eq("store_id", store.id)
      .eq("is_visible", true);

    // Filter by product_id if provided
    if (productId) {
      query = query.eq("product_id", productId);
    }

    const {
      data: reviews,
      error,
      count,
    } = await query
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Calculate average rating from all matching reviews (not just current page)
    let allRatingsQuery = this.supabase
      .from("store_reviews")
      .select("rating")
      .eq("store_id", store.id)
      .eq("is_visible", true);

    if (productId) {
      allRatingsQuery = allRatingsQuery.eq("product_id", productId);
    }

    const { data: allRatings } = await allRatingsQuery;

    const totalCount = allRatings?.length || 0;
    const averageRating =
      totalCount > 0
        ? allRatings!.reduce((sum, r) => sum + r.rating, 0) / totalCount
        : 0;

    // Enrich with product info
    const enrichedReviews = [];
    for (const review of reviews || []) {
      let productName = null;
      let productImage = null;
      if (review.product_id) {
        const { data: product } = await this.supabase
          .from("products")
          .select("name, cover_image")
          .eq("id", review.product_id)
          .single();
        productName = product?.name;
        productImage = product?.cover_image;
      }
      enrichedReviews.push({
        ...review,
        product_name: productName,
        product_image: productImage,
      });
    }

    return {
      data: enrichedReviews,
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
      summary: {
        average_rating: Math.round(averageRating * 10) / 10, // Round to 1 decimal
        total_count: totalCount,
      },
    };
  }

  /**
   * Submit a review
   * POST /store/public/:slug/reviews
   */
  async submitReview(
    slug: string,
    data: {
      product_id: string;
      customer_name: string;
      customer_email: string;
      rating: number;
      title?: string;
      content?: string;
      order_id?: string;
    },
  ): Promise<{ id: string }> {
    // Get store
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    // Validate product exists and belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", data.product_id)
      .eq("store_id", store.id)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Check if verified purchase (if order_id provided)
    let isVerified = false;
    if (data.order_id) {
      const { data: order } = await this.supabase
        .from("orders")
        .select("id, status")
        .eq("id", data.order_id)
        .eq("store_id", store.id)
        .in("status", ["paid", "fulfilled"])
        .single();
      isVerified = !!order;
    }

    // Insert review (is_visible: true by default)
    const { data: review, error } = await this.supabase
      .from("store_reviews")
      .insert([
        {
          store_id: store.id,
          product_id: data.product_id,
          customer_name: data.customer_name,
          customer_email: data.customer_email,
          rating: data.rating,
          title: data.title || null,
          content: data.content || null,
          order_id: data.order_id || null,
          is_verified: isVerified,
          is_visible: true,
        },
      ])
      .select("id")
      .single();

    if (error) {
      if (error.code === "23505") {
        throw Object.assign(
          new Error("You have already reviewed this order/product"),
          { statusCode: 409 },
        );
      }
      throw error;
    }

    return { id: review.id };
  }

  /**
   * Get store reviews (merchant dashboard)
   */
  async getStoreReviews(
    storeId: string,
    page: number,
    limit: number,
  ): Promise<{
    data: any[];
    meta: { total: number; page: number; limit: number; totalPages: number };
    summary: { average_rating: number; total_count: number };
  }> {
    const offset = (page - 1) * limit;
    const {
      data: reviews,
      error,
      count,
    } = await this.supabase
      .from("store_reviews")
      .select("*, products(name, cover_image)", { count: "exact" })
      .eq("store_id", storeId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    // Calculate summary
    const { data: allReviews } = await this.supabase
      .from("store_reviews")
      .select("rating")
      .eq("store_id", storeId)
      .eq("is_visible", true);

    const totalVisible = allReviews?.length || 0;
    const averageRating =
      totalVisible > 0
        ? allReviews!.reduce((sum, r) => sum + r.rating, 0) / totalVisible
        : 0;

    return {
      data: (reviews || []).map((r: any) => ({
        ...r,
        product_name: r.products?.name || null,
        product_image: r.products?.cover_image || null,
      })),
      meta: {
        total: count || 0,
        page,
        limit,
        totalPages: Math.ceil((count || 0) / limit),
      },
      summary: {
        average_rating: Math.round(averageRating * 10) / 10,
        total_count: totalVisible,
      },
    };
  }

  /**
   * Update review visibility
   */
  async updateReviewVisibility(
    storeId: string,
    reviewId: string,
    isVisible: boolean,
  ): Promise<{ id: string; is_visible: boolean }> {
    const { data: existing } = await this.supabase
      .from("store_reviews")
      .select("id")
      .eq("id", reviewId)
      .eq("store_id", storeId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Review not found"), { statusCode: 404 });
    }

    const { data, error } = await this.supabase
      .from("store_reviews")
      .update({ is_visible: isVisible, updated_at: new Date().toISOString() })
      .eq("id", reviewId)
      .select("id, is_visible")
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Delete review
   */
  async deleteReview(storeId: string, reviewId: string): Promise<void> {
    const { data: existing } = await this.supabase
      .from("store_reviews")
      .select("id")
      .eq("id", reviewId)
      .eq("store_id", storeId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Review not found"), { statusCode: 404 });
    }

    const { error } = await this.supabase
      .from("store_reviews")
      .delete()
      .eq("id", reviewId);

    if (error) throw error;
  }

  /**
   * Sync product variants (internal use by add/update product)
   */
  private async syncProductVariants(
    productId: string,
    variants: any[],
  ): Promise<void> {
    if (!variants || !Array.isArray(variants)) return;
    const isUuid = (value: unknown): value is string =>
      typeof value === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

    // 1. Get existing variants
    const { data: existing } = await supabaseAdmin
      .from("product_variants")
      .select("id")
      .eq("product_id", productId);

    const existingIds = new Set(existing?.map((v) => v.id) || []);
    const providedIds = new Set(
      variants
        .filter((v) => isUuid(v.id))
        .map((v) => v.id),
    );

    // 2. Delete variants not provided (that exist in DB but not in payload)
    const toDelete =
      existing?.filter((v) => !providedIds.has(v.id)).map((v) => v.id) || [];
    if (toDelete.length > 0) {
      await supabaseAdmin.from("product_variants").delete().in("id", toDelete);
    }

    // 3. Update or Create variants
    for (const v of variants) {
      const variantData: any = {
        product_id: productId,
        name: v.name || "",
        group_name: v.group_name || "Options",
        group_ui_type: v.group_ui_type || "pills",
        options: Array.isArray(v.options) ? v.options : [],
        price_adjustment: Number(v.price_adjustment || 0),
        compare_at_price:
          v.compare_at_price !== undefined && v.compare_at_price !== null
            ? Number(v.compare_at_price)
            : null,
        cost: v.cost !== undefined && v.cost !== null ? Number(v.cost) : null,
        stock:
          v.stock !== undefined && v.stock !== null ? Number(v.stock) : null,
        sku: v.sku || null,
        barcode: v.barcode || null,
        weight: v.weight !== undefined && v.weight !== null ? Number(v.weight) : null,
        color_value: v.color_value || null,
        is_active: v.is_active !== false,
        position: v.position || 0,
        updated_at: new Date().toISOString(),
      };

      if (isUuid(v.id) && existingIds.has(v.id)) {
        // Update existing variant
        await supabaseAdmin
          .from("product_variants")
          .update(variantData)
          .eq("id", v.id);
      } else {
        // Create new variant
        await supabaseAdmin.from("product_variants").insert([
          {
            ...(isUuid(v.id) ? { id: v.id } : {}),
            ...variantData,
            created_at: new Date().toISOString(),
          },
        ]);
      }
    }
  }

  // ============================================================================
  // Product Variants
  // ============================================================================

  /**
   * Get all variants for a product
   */
  async getProductVariants(
    storeId: string,
    productId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      group_name: string;
      group_ui_type: string;
      options: Array<{ name: string; value: string }>;
      price_adjustment: number;
      stock: number | null;
      sku: string | null;
      color_value: string | null;
      is_active: boolean;
      position: number;
      compare_at_price: number | null;
      created_at: string;
    }>
  > {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    const { data, error } = await supabaseAdmin
      .from("product_variants")
      .select(
        "id, name, group_name, group_ui_type, options, price_adjustment, compare_at_price, cost, stock, sku, barcode, weight, color_value, is_active, position, created_at",
      )
      .eq("product_id", productId)
      .order("group_name", { ascending: true })
      .order("position", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a product variant
   */
  async createProductVariant(
    storeId: string,
    productId: string,
    data: {
      name: string;
      group_name?: string;
      group_ui_type?: "pills" | "color" | "dropdown";
      options?: Array<{ name: string; value: string }>;
      price_adjustment?: number;
      stock?: number | null;
      sku?: string | null;
      color_value?: string | null;
      is_active?: boolean;
      position?: number;
      compare_at_price?: number | null;
    },
  ): Promise<{
    id: string;
    name: string;
    options: Array<{ name: string; value: string }>;
    price_adjustment: number;
    compare_at_price: number | null;
    stock: number | null;
    sku: string | null;
    is_active: boolean;
    position: number;
  }> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Get max position if not provided
    let position = data.position;
    if (position === undefined) {
      const { data: maxPos } = await supabaseAdmin
        .from("product_variants")
        .select("position")
        .eq("product_id", productId)
        .order("position", { ascending: false })
        .limit(1)
        .single();
      position = (maxPos?.position || 0) + 1;
    }

    const { data: variant, error } = await supabaseAdmin
      .from("product_variants")
      .insert([
        {
          product_id: productId,
          name: data.name,
          group_name: data.group_name || "Options",
          group_ui_type: data.group_ui_type || "pills",
          options: data.options ?? [],
          price_adjustment: data.price_adjustment || 0,
          stock: data.stock ?? null,
          sku: data.sku ?? null,
          color_value: data.color_value ?? null,
          is_active: data.is_active !== false,
          position,
          compare_at_price: data.compare_at_price ?? null,
        },
      ])
      .select(
        "id, name, group_name, group_ui_type, options, price_adjustment, compare_at_price, stock, sku, color_value, is_active, position",
      )
      .single();

    if (error) throw error;
    return variant;
  }

  /**
   * Update a product variant
   */
  async updateProductVariant(
    storeId: string,
    productId: string,
    variantId: string,
    updates: {
      name?: string;
      group_name?: string;
      group_ui_type?: "pills" | "color" | "dropdown";
      options?: Array<{ name: string; value: string }>;
      price_adjustment?: number;
      stock?: number | null;
      sku?: string | null;
      color_value?: string | null;
      is_active?: boolean;
      position?: number;
      compare_at_price?: number | null;
    },
  ): Promise<{
    id: string;
    name: string;
    options: Array<{ name: string; value: string }>;
    price_adjustment: number;
    compare_at_price: number | null;
    stock: number | null;
    sku: string | null;
    color_value: string | null;
    is_active: boolean;
    position: number;
  }> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify variant belongs to product
    const { data: existing } = await supabaseAdmin
      .from("product_variants")
      .select("id")
      .eq("id", variantId)
      .eq("product_id", productId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
    }

    const { data: variant, error } = await supabaseAdmin
      .from("product_variants")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", variantId)
      .select(
        "id, name, group_name, group_ui_type, options, price_adjustment, compare_at_price, stock, sku, color_value, is_active, position",
      )
      .single();

    if (error) throw error;
    return variant;
  }

  /**
   * Delete a product variant
   */
  async deleteProductVariant(
    storeId: string,
    productId: string,
    variantId: string,
  ): Promise<void> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify variant belongs to product
    const { data: existing } = await supabaseAdmin
      .from("product_variants")
      .select("id")
      .eq("id", variantId)
      .eq("product_id", productId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Variant not found"), { statusCode: 404 });
    }

    const { error } = await supabaseAdmin
      .from("product_variants")
      .delete()
      .eq("id", variantId);

    if (error) throw error;
  }

  /**
   * Reorder product variants
   */
  async reorderProductVariants(
    storeId: string,
    productId: string,
    order: string[],
  ): Promise<void> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify all variants belong to product
    const { data: existing } = await supabaseAdmin
      .from("product_variants")
      .select("id")
      .eq("product_id", productId)
      .in("id", order);

    if (!existing || existing.length !== order.length) {
      throw Object.assign(new Error("One or more variants not found"), {
        statusCode: 404,
      });
    }

    // Update positions
    for (let i = 0; i < order.length; i++) {
      await supabaseAdmin
        .from("product_variants")
        .update({ position: i, updated_at: new Date().toISOString() })
        .eq("id", order[i]);
    }
  }

  // ============================================================================
  // Product Versions
  // ============================================================================

  /**
   * Get all versions for a product
   */
  async getProductVersions(
    storeId: string,
    productId: string,
  ): Promise<
    Array<{
      id: string;
      version_name: string;
      release_notes: string | null;
      is_active: boolean;
      created_at: string;
    }>
  > {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    const { data, error } = await this.supabase
      .from("product_versions")
      .select("id, version_name, release_notes, is_active, created_at")
      .eq("product_id", productId)
      .order("created_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Create a product version
   */
  async createProductVersion(
    storeId: string,
    productId: string,
    data: {
      version_name: string;
      release_notes?: string | null;
      is_active?: boolean;
    },
  ): Promise<{
    id: string;
    version_name: string;
    release_notes: string | null;
    is_active: boolean;
  }> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // If setting as active, deactivate others first
    if (data.is_active) {
      await this.supabase
        .from("product_versions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("product_id", productId);
    }

    const { data: version, error } = await this.supabase
      .from("product_versions")
      .insert([
        {
          product_id: productId,
          store_id: storeId,
          version_name: data.version_name,
          release_notes: data.release_notes || null,
          is_active: data.is_active || false,
        },
      ])
      .select("id, version_name, release_notes, is_active")
      .single();

    if (error) throw error;
    return version;
  }

  /**
   * Update a product version
   */
  async updateProductVersion(
    storeId: string,
    productId: string,
    versionId: string,
    updates: {
      version_name?: string;
      release_notes?: string | null;
      is_active?: boolean;
    },
  ): Promise<{
    id: string;
    version_name: string;
    release_notes: string | null;
    is_active: boolean;
  }> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify version belongs to product
    const { data: existing } = await this.supabase
      .from("product_versions")
      .select("id")
      .eq("id", versionId)
      .eq("product_id", productId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Version not found"), { statusCode: 404 });
    }

    // If setting as active, deactivate others first
    if (updates.is_active) {
      await this.supabase
        .from("product_versions")
        .update({ is_active: false, updated_at: new Date().toISOString() })
        .eq("product_id", productId)
        .neq("id", versionId);
    }

    const { data: version, error } = await this.supabase
      .from("product_versions")
      .update({
        ...updates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", versionId)
      .select("id, version_name, release_notes, is_active")
      .single();

    if (error) throw error;
    return version;
  }

  /**
   * Activate a specific version (deactivates all others)
   */
  async activateProductVersion(
    storeId: string,
    productId: string,
    versionId: string,
  ): Promise<{
    id: string;
    version_name: string;
    is_active: boolean;
  }> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify version belongs to product
    const { data: existing } = await this.supabase
      .from("product_versions")
      .select("id")
      .eq("id", versionId)
      .eq("product_id", productId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Version not found"), { statusCode: 404 });
    }

    // Deactivate all other versions
    await this.supabase
      .from("product_versions")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("product_id", productId);

    // Activate target version
    const { data: version, error } = await this.supabase
      .from("product_versions")
      .update({ is_active: true, updated_at: new Date().toISOString() })
      .eq("id", versionId)
      .select("id, version_name, is_active")
      .single();

    if (error) throw error;
    return version;
  }

  /**
   * Delete a product version
   */
  async deleteProductVersion(
    storeId: string,
    productId: string,
    versionId: string,
  ): Promise<void> {
    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", storeId)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Verify version belongs to product
    const { data: existing } = await this.supabase
      .from("product_versions")
      .select("id")
      .eq("id", versionId)
      .eq("product_id", productId)
      .single();

    if (!existing) {
      throw Object.assign(new Error("Version not found"), { statusCode: 404 });
    }

    const { error } = await this.supabase
      .from("product_versions")
      .delete()
      .eq("id", versionId);

    if (error) throw error;
  }

  // ============================================================================
  // Public Endpoints
  // ============================================================================

  /**
   * Get active variants for a product (public, no auth)
   */
  async getPublicProductVariants(
    slug: string,
    productId: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      group_name: string;
      group_ui_type: string;
      options: Array<{ name: string; value: string }>;
      price_adjustment: number;
      stock: number | null;
      is_active: boolean;
      color_value: string | null;
      compare_at_price: number | null;
    }>
  > {
    // Get store by slug
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    // Verify product belongs to store
    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", store.id)
      .eq("status", "published")
      .eq("is_sellable", true)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    // Get active variants only
    const { data, error } = await supabaseAdmin
      .from("product_variants")
      .select(
        "id, name, group_name, group_ui_type, options, price_adjustment, compare_at_price, stock, is_active, color_value",
      )
      .eq("product_id", productId)
      .eq("is_active", true)
      .order("group_name", { ascending: true })
      .order("position", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Modifier/add-on groups attached to a published product, with only
   * available options — the customer-facing counterpart to
   * getProductModifierGroups (merchant, authenticated, includes unavailable
   * options so they can be re-enabled).
   */
  async getPublicProductModifierGroups(
    slug: string,
    productId: string,
    branchId?: string | null,
  ): Promise<ModifierGroup[]> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const { data: product } = await this.supabase
      .from("products")
      .select("id")
      .eq("id", productId)
      .eq("store_id", store.id)
      .eq("status", "published")
      .eq("is_sellable", true)
      .single();

    if (!product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }

    const groups = await this.getProductModifierGroups(store.id, productId);
    const branchScoped = branchId
      ? groups.filter((g) => !g.branch_ids || g.branch_ids.includes(branchId))
      : groups;
    return branchScoped.map((g) => ({
      ...g,
      options: (g.options || []).filter(
        (o) =>
          o.is_available &&
          (!branchId || !o.branch_ids || o.branch_ids.includes(branchId)),
      ),
    }));
  }

  /**
   * Active branches for a published, live food store — customer-facing
   * counterpart to the merchant branch settings endpoint.
   */
  async getPublicStoreBranches(slug: string): Promise<StoreBranch[]> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const branches = await this.getStoreBranches(store.id);
    return branches.filter((b) => b.is_active);
  }

  /**
   * Active menus for a published, live food store, optionally filtered to
   * ones offered at a given branch (branch_ids null = all branches) —
   * customer-facing counterpart to the merchant menu settings endpoint.
   */
  async getPublicStoreMenus(
    slug: string,
    branchId?: string | null,
  ): Promise<StoreMenu[]> {
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const { data: menus, error } = await this.supabase
      .from("store_categories")
      .select("*")
      .eq("store_id", store.id)
      .eq("is_menu", true)
      .eq("is_active", true)
      .order("position", { ascending: true });

    if (error) throw error;

    const activeMenus = (menus || []) as StoreMenu[];
    if (!branchId) return activeMenus;
    return activeMenus.filter(
      (m) => !m.branch_ids || m.branch_ids.includes(branchId),
    );
  }

  // ============================================================================
  // Store Reviews
  // ============================================================================

  /**
   * Get public reviews for a store
   */
  async getPublicStoreReviews(
    slug: string,
    params: { product_id?: string; page?: number; limit?: number },
  ): Promise<{
    reviews: StoreReview[];
    summary: { total_count: number; average_rating: number };
  }> {
    const { product_id, page = 1, limit = 10 } = params;

    // Get store by slug
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    // Base query
    let query = this.supabase
      .from("store_reviews")
      .select("*", { count: "exact" })
      .eq("store_id", store.id)
      .eq("is_visible", true);

    // Filter by product if provided
    if (product_id) {
      query = query.eq("product_id", product_id);
    }

    // Pagination
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await query
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;

    let average_rating = 0.0;

    // Calculate average rating
    if (count && count > 0) {
      // optimization: simplified average
      // In a real scenario we might use an RPC call or separate stats query
      if (data && data.length > 0) {
        // Fetch all ratings separately so pagination doesn't skew the average
        const { data: ratings } = await this.supabase
          .from("store_reviews")
          .select("rating")
          .eq("store_id", store.id)
          .eq("is_visible", true)
          .match(product_id ? { product_id } : {}); // Use match for dynamic filter

        if (ratings && ratings.length > 0) {
          const sum = ratings.reduce((acc, r) => acc + r.rating, 0);
          average_rating = Number((sum / ratings.length).toFixed(1));
        }
      }
    }

    return {
      reviews: (data as StoreReview[]) || [],
      summary: {
        total_count: count || 0,
        average_rating,
      },
    };
  }

  /**
   * Submit a review (public)
   */
  async submitStoreReview(
    slug: string,
    data: {
      product_id?: string | null;
      customer_name: string;
      customer_email: string;
      rating: number;
      title?: string;
      content?: string;
    },
  ): Promise<void> {
    // Get store by slug
    const { data: store } = await this.supabase
      .from("stores")
      .select("id")
      .eq("slug", slug)
      .eq("is_live", true)
      .single();

    if (!store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    // Verify product if provided
    if (data.product_id) {
      const { data: product } = await this.supabase
        .from("products")
        .select("id")
        .eq("id", data.product_id)
        .eq("store_id", store.id)
        .single();

      if (!product) {
        throw Object.assign(new Error("Product not found"), {
          statusCode: 404,
        });
      }
    }

    const { error } = await this.supabase.from("store_reviews").insert({
      store_id: store.id,
      product_id: data.product_id || null,
      customer_name: data.customer_name,
      customer_email: data.customer_email,
      rating: data.rating,
      title: data.title || null,
      content: data.content || null,
      is_verified: false,
      is_visible: true,
    });

    if (error) {
      console.error("Error submitting store review:", error);
      throw error;
    }
  }

  /**
   * Find the first available booking slot for a product
   * Searches up to 7 days into the future
   */
  private async findDefaultSlot(
    productId: string,
  ): Promise<{ startTime: string; endTime: string; date: string } | null> {
    const availabilityService = new AvailabilityService(this.supabase);
    const now = new Date();

    // Check next 7 days
    for (let i = 0; i < 7; i++) {
      const date = new Date(now);
      date.setDate(now.getDate() + i);
      const dateStr = date.toISOString().split("T")[0]; // YYYY-MM-DD

      try {
        const { slots } = await availabilityService.getAvailableSlots(
          productId,
          dateStr,
        );
        const firstAvailable = slots.find((s) => s.available);

        if (firstAvailable) {
          return {
            date: dateStr,
            startTime: firstAvailable.startTime,
            endTime: firstAvailable.endTime,
          };
        }
      } catch (error) {
        // Skip dates that might be disallowed by rules (e.g. blackout)
        continue;
      }
    }

    return null;
  }
}

export const storeService = new StoreService(
  require("../config/supabase").supabase,
);
