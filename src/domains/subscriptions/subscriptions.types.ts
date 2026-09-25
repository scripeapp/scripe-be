/**
 * API and domain types for the Scripe plan, entitlement, invoice, payment,
 * and dunning domain. Database row types remain generated and separate.
 * This is Scripe's own SaaS billing of its merchant customers, not a
 * merchant's own customer-facing product subscriptions.
 */

export type PlanCode = "starter" | "plus" | "pro";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired";

export interface PlanRow {
  readonly code: PlanCode;
  readonly name: string;
  readonly priceMonthlyMinor: string;
  readonly assetCode: string;
  readonly paystackPlanCode: string | null;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface Plan extends PlanRow {}

export type EntitlementKind = "limit" | "feature";

export interface PlanEntitlementRow {
  readonly id: string;
  readonly planCode: PlanCode;
  readonly key: string;
  readonly kind: EntitlementKind;
  readonly limitValue: string | null;
  readonly featureEnabled: boolean | null;
}

export interface PlanEntitlement extends PlanEntitlementRow {}

/** A row-absent limit means unlimited; distinguished from `limitValue: 0` (present, explicitly zero). */
export interface ResolvedEntitlement {
  readonly key: string;
  readonly kind: EntitlementKind | null;
  readonly limitValue: number | null;
  readonly unlimited: boolean;
  readonly featureEnabled: boolean;
}

export interface BusinessSubscriptionRow {
  readonly id: string;
  readonly businessId: string;
  readonly planCode: PlanCode;
  readonly status: SubscriptionStatus;
  readonly providerSubscriptionCode: string | null;
  readonly providerCustomerCode: string | null;
  readonly providerEmailToken: string | null;
  readonly startedAt: Date;
  readonly currentPeriodEndsAt: Date | null;
  readonly cancelledAt: Date | null;
  readonly endedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface BusinessSubscription extends Omit<BusinessSubscriptionRow, "startedAt" | "currentPeriodEndsAt" | "cancelledAt" | "endedAt" | "createdAt" | "updatedAt"> {
  readonly startedAt: string;
  readonly currentPeriodEndsAt: string | null;
  readonly cancelledAt: string | null;
  readonly endedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly canCancel: boolean;
}

export type InvoiceStatus = "pending" | "paid" | "failed";

export interface SubscriptionInvoiceRow {
  readonly id: string;
  readonly businessId: string;
  readonly subscriptionId: string;
  readonly amountMinor: string;
  readonly assetCode: string;
  readonly status: InvoiceStatus;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  readonly providerReference: string | null;
  readonly paidAt: Date | null;
  readonly createdAt: Date;
}

export interface SubscriptionInvoice extends Omit<SubscriptionInvoiceRow, "periodStart" | "periodEnd" | "paidAt" | "createdAt"> {
  readonly periodStart: string | null;
  readonly periodEnd: string | null;
  readonly paidAt: string | null;
  readonly createdAt: string;
}

export interface InitiateSubscriptionInput {
  readonly plan: Extract<PlanCode, "plus" | "pro">;
  readonly callbackUrl?: string;
}

export interface InitiatedSubscription {
  readonly authorizationUrl: string;
  readonly reference: string;
}

export interface UsageReportEntry {
  readonly key: string;
  readonly used: number;
  readonly limit: number | null;
  readonly unlimited: boolean;
}

export interface SubscriptionsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

/** Plans are a global catalog, not business-scoped - listing them needs no business context. */
export interface PlansOperation {
  readonly userId: string;
  readonly requestId: string;
}
