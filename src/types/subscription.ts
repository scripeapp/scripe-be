/**
 * Business Subscription Types
 */

export type SubscriptionPlan = "starter" | "plus" | "pro";
export type SubscriptionStatus =
  | "active"
  | "trialing"
  | "cancelled"
  | "expired"
  | "past_due"
  | null;

export interface BusinessSubscription {
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  started_at: string | null;
  expires_at: string | null;
  next_payment_date: string | null;
  can_cancel: boolean;
}

export interface PlanLimits {
  publications: number | "unlimited";
  products: number | "unlimited";
  website_pages: number | "unlimited";
  crm_contacts: number | "unlimited";
  team_members: number | "unlimited";
  segments: number | "unlimited";
  emails_per_month: number | "unlimited";
  forms: number | "unlimited";
}

export interface PlanFeatures {
  events: boolean;
  store: boolean;
  digital_downloads: boolean;
  courses: boolean;
  memberships: boolean;
  services_bookings: boolean;
  advanced_page_builder: boolean;
  custom_domain: boolean;
  custom_roles: boolean;
  email_support: boolean;
  priority_support: boolean;
  advanced_analytics: boolean;
  ai_assistant: boolean;
  forms: boolean;
}

export interface PlanConfig {
  id: string;
  plan: SubscriptionPlan;
  limits: PlanLimits;
  features: PlanFeatures;
  price_monthly: number;
  price_yearly: number | null;
  paystack_plan_code: string | null;
}

export interface UsageItem {
  used: number;
  limit: number | "unlimited";
}

export interface UsageItemWithAvailable {
  used: number;
  limit: number | "unlimited";
  available: number | "unlimited";
}

export interface UsageReport {
  publications: UsageItem;
  products: UsageItem;
  website_pages: UsageItem;
  crm_contacts: UsageItem;
  team_members: UsageItem;
  segments: UsageItem;
  emails_per_month: UsageItem;
  forms: UsageItem;
}

export interface ExtendedUsageReport {
  plan: SubscriptionPlan;
  resources: {
    publications: UsageItemWithAvailable;
    products: UsageItemWithAvailable;
    team_members: UsageItemWithAvailable;
    website_pages: UsageItemWithAvailable;
    crm_contacts: UsageItemWithAvailable;
    segments: UsageItemWithAvailable;
    emails_per_month: UsageItemWithAvailable;
    forms: UsageItemWithAvailable;
  };
  features: PlanFeatures;
}

export interface Invoice {
  id: string;
  amount: number;
  currency: string;
  status: string;
  paid_at: string | null;
  created_at: string;
  description: string;
}

export interface InitiateSubscriptionResponse {
  authorization_url: string;
  reference: string;
}

// Plan limit resource types
export type LimitResource = keyof PlanLimits;
export type FeatureType = keyof PlanFeatures;

// Fee calculation constants
export const TRANSACTION_FEE_PERCENTAGE = 0.03; // 3%
export const TRANSACTION_FEE_FLAT = 100; // ₦100

export function calculateFee(amount: number): number {
  return Math.round(amount * TRANSACTION_FEE_PERCENTAGE) + TRANSACTION_FEE_FLAT;
}

export function getBusinessPayout(total: number): number {
  return total - calculateFee(total);
}
