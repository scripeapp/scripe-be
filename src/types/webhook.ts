import type { FeeBearer } from "./payment";
import { Recipient } from "./models";

export interface CustomField {
  variable_name?: string;
  display_name?: string;
  value: string;
}

export interface CheckoutFxEvidence {
  source: "base_currency" | "flutterwave";
  rate: number;
  rate_timestamp: string;
  source_currency: "NGN";
  target_currency: string;
}

export interface CheckoutPricingLine {
  product_id: string;
  product_name: string;
  variant_id?: string | null;
  variant_name?: string | null;
  quantity: number;
  base_unit_price_ngn: number;
  base_variant_adjustment_ngn: number;
  converted_unit_price: number;
  converted_variant_adjustment: number;
  converted_line_total: number;
  pricing_source: "explicit_currency_price" | "fx_conversion" | "base_currency";
  base_price_fx?: CheckoutFxEvidence;
  variant_fx?: CheckoutFxEvidence;
}

export interface CheckoutConvertedComponent {
  original_amount_ngn: number;
  converted_amount: number;
  fx?: CheckoutFxEvidence;
}

export interface CheckoutPricingSnapshot {
  version: 1;
  currency: string;
  created_at: string;
  items: CheckoutPricingLine[];
  subtotal: number;
  discount: number;
  delivery: CheckoutConvertedComponent;
  tax: CheckoutConvertedComponent;
  service_charge: CheckoutConvertedComponent;
  pre_provider_fee_total: number;
  platform_fee: number;
  provider_fee: number;
  amount_sent_to_provider: number;
}

export interface EventPaymentSummary {
  currency: string;
  subtotal: number;
  discount: number;
  surcharge: number;
  amount: number;
  coupon_code?: string | null;
  coupon_applied: boolean;
  discounts?: Array<{
    rule_id: string;
    mode: "flat" | "percent";
    value: number;
    amount: number;
    coupon_code?: string;
    message?: string;
  }>;
}

export interface PaystackMetadata {
  full_name?: string;
  email?: string;
  phone_number?: string;
  gender?: string;
  custom_answers?: Record<string, string>;
  event_id?: string;
  event_payment_summary?: EventPaymentSummary;
  selectedTickets?: Record<string, number>;
  tickets?: any[];
  custom_fields?: CustomField[];
  recipients?: Recipient[];
  // Store purchase fields
  store_id?: string;
  business_id?: string;
  items?: any[];
  customer_name?: string;
  customer_email?: string;
  customer_phone?: string;
  customer_address?: string;
  discount_code?: string;
  discount_details?: Array<{
    id: string;
    kind: "code" | "automatic";
    name: string;
    code: string | null;
    amount: number;
    show_on_storefront: boolean;
  }>;
  referrer?: string;
  // Transaction type identifier (replaces reference prefix approach)
  transaction_type?:
    | "store_purchase"
    | "event_ticket"
    | "subscription"
    | "form_submission"
    | "booking_payment"
    | "scheduling_payment"
    | "cohort_enrollment"
    | "tipping"
    | "campaign_credit_topup";
  // Cohort enrollment fields
  cohort_id?: string;
  cohort_price?: number;
  instalment_number?: 1 | 2;
  booking_id?: string;
  // Fee metadata for reconciliation
  items_total?: number;
  // Pre-fee items total already converted to the charge currency, honouring any
  // explicit per-currency product prices. Used to verify non-NGN charges without
  // re-running FX. Absent for legacy/NGN orders, which verify against items_total.
  converted_items_total?: number;
  // Currency-aware pricing breakdown used by receipts and merchant emails.
  // These remain separate from store_orders, whose accounting fields are NGN.
  converted_subtotal?: number;
  converted_discount?: number;
  pricing_snapshot?: CheckoutPricingSnapshot;
  platform_fee?: number;
  gateway_fee_estimate?: number;
  paystack_fee_estimate?: number;
  fee_bearer?: FeeBearer;
  // Publication subscription fields
  subscription_type?: string;
  publication_id?: string;
  publication_name?: string;
  user_id?: string;
  product_id?: string;
  plan?: string;
  existing_subscription_id?: string;
  type?: string;
  plan_id?: string;
  plan_name?: string;
  billing_cycle?:
    | "daily"
    | "weekly"
    | "monthly"
    | "quarterly"
    | "biannually"
    | "annually"
    | "one-time";
  source?: string;
  store_product_id?: string;
  // Form submission fields
  form_id?: string;
  form_slug?: string;
  form_title?: string;
  form_data?: Record<string, any>;
  // Booking / scheduling fields
  event_type_id?: string;
  attendee_name?: string;
  attendee_email?: string;
  product_name?: string;
  store_name?: string;
  slot?: unknown;
  // Store delivery fields
  delivery_method_id?: string;
  delivery_fee?: number;
  converted_delivery_fee?: number;
  delivery_name?: string;
  delivery_provider?: string;
  delivery_service_code?: string;
  delivery_courier_id?: string;
  delivery_city?: string;
  delivery_state?: string;
  // Food store fulfilment (PRD Phase 4)
  fulfillment_type?: "dine_in" | "pickup" | "delivery" | "curbside";
  branch_id?: string;
  utensils_requested?: boolean;
  tax_amount?: number;
  service_charge_amount?: number;
  notes?: string;
  qr_code_id?: string;
  location_label?: string;
  // Course fields
  course_id?: string;
  // Paystack subscription fields (returned from verification)
  paystack_subscription_code?: string;
  paystack_customer_code?: string;
  credits?: number;
  package_id?: string;
  // Multi-currency support
  currency?: string;
  payment_provider?: "paystack" | "flutterwave";
  flw_subaccount_id?: string;
}

// Alias used by the provider abstraction layer
export type PaymentMetadata = PaystackMetadata;

export interface PaystackPlan {
  name: string;
}

export interface PaystackPaymentData {
  reference: string;
  amount: number;
  status: string;
  metadata: PaystackMetadata;
  customer?: {
    name?: string;
    first_name?: string;
    last_name?: string;
    email: string;
    phone?: string;
    customer_code?: string;
  };
  plan?: PaystackPlan;
  // Optional — present when this data is surfaced through NormalisedPaymentData
  currency?: string;
  provider?: "paystack" | "flutterwave";
}
