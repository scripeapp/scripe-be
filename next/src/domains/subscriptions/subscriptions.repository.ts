import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import type { BusinessSubscriptionRow, PlanCode, PlanEntitlementRow, PlanRow, SubscriptionInvoiceRow, SubscriptionStatus } from "./subscriptions.types.js";

const PLAN_COLUMNS = sql`"code", "name", "priceMonthlyMinor"::text as "priceMonthlyMinor", "assetCode", "paystackPlanCode", "isActive", "sortOrder"`;

export async function findUserEmail(context: DatabaseContext, userId: string): Promise<string | undefined> {
  const result = await sql<{ email: string }>`select "email" from auth.user where "id" = ${userId}::uuid`.execute(context.transaction);
  return result.rows[0]?.email;
}

export async function listPlans(context: DatabaseContext): Promise<PlanRow[]> {
  const result = await sql<PlanRow>`select ${PLAN_COLUMNS} from app.platform_plans where "isActive" order by "sortOrder"`.execute(context.transaction);
  return result.rows;
}

export async function findPlan(context: DatabaseContext, code: PlanCode): Promise<PlanRow | undefined> {
  const result = await sql<PlanRow>`select ${PLAN_COLUMNS} from app.platform_plans where "code" = ${code}`.execute(context.transaction);
  return result.rows[0];
}

export async function listPlanEntitlements(context: DatabaseContext, planCode: PlanCode): Promise<PlanEntitlementRow[]> {
  const result = await sql<PlanEntitlementRow>`
    select "id", "planCode", "key", "kind", "limitValue"::text as "limitValue", "featureEnabled"
    from app.platform_plan_entitlements where "planCode" = ${planCode} order by "key"
  `.execute(context.transaction);
  return result.rows;
}

/** A row-absent limit is unlimited (never zero); a row-absent feature is disabled (never enabled) - the two entitlement kinds have opposite "missing" defaults, matching legacy's plan_limits shape. */
export async function resolveEntitlement(context: DatabaseContext, businessId: string, key: string): Promise<{ kind: "limit" | "feature" | null; limitValue: string | null; featureEnabled: boolean | null }> {
  const result = await sql<{ kind: "limit" | "feature" | null; limitValue: string | null; featureEnabled: boolean | null }>`
    select "kind", "limitValue"::text as "limitValue", "featureEnabled" from app.get_business_entitlement(${businessId}::uuid, ${key})
  `.execute(context.transaction);
  return result.rows[0] ?? { kind: null, limitValue: null, featureEnabled: null };
}

const SUBSCRIPTION_COLUMNS = sql`
  "id", "businessId", "planCode", "status", "providerSubscriptionCode", "providerCustomerCode", "providerEmailToken",
  "startedAt", "currentPeriodEndsAt", "cancelledAt", "endedAt", "createdAt", "updatedAt"
`;

/** The one non-terminal subscription, if any - the "is there something active to act on" question (webhooks, cancel, initiate). Terminal (cancelled/expired) history is excluded by design; use findMostRecentSubscription for "what should we display". */
export async function findCurrentSubscription(context: DatabaseContext, businessId: string): Promise<BusinessSubscriptionRow | undefined> {
  const result = await sql<BusinessSubscriptionRow>`
    select ${SUBSCRIPTION_COLUMNS} from app.business_subscriptions
    where "businessId" = ${businessId}::uuid and "status" in ('trialing', 'active', 'past_due')
  `.execute(context.transaction);
  return result.rows[0];
}

/** The "what should we display as this business's subscription" question - includes a just-cancelled row (access continues until currentPeriodEndsAt) rather than silently reverting to the starter default the instant it's cancelled. */
export async function findMostRecentSubscription(context: DatabaseContext, businessId: string): Promise<BusinessSubscriptionRow | undefined> {
  const result = await sql<BusinessSubscriptionRow>`
    select ${SUBSCRIPTION_COLUMNS} from app.business_subscriptions where "businessId" = ${businessId}::uuid order by "createdAt" desc limit 1
  `.execute(context.transaction);
  return result.rows[0];
}

export async function findSubscription(context: DatabaseContext, businessId: string, subscriptionId: string): Promise<BusinessSubscriptionRow | undefined> {
  const result = await sql<BusinessSubscriptionRow>`
    select ${SUBSCRIPTION_COLUMNS} from app.business_subscriptions where "businessId" = ${businessId}::uuid and "id" = ${subscriptionId}::uuid
  `.execute(context.transaction);
  return result.rows[0];
}

export async function listInvoices(context: DatabaseContext, businessId: string, limit: number): Promise<SubscriptionInvoiceRow[]> {
  const result = await sql<SubscriptionInvoiceRow>`
    select "id", "businessId", "subscriptionId", "amountMinor"::text as "amountMinor", "assetCode", "status", "periodStart", "periodEnd", "providerReference", "paidAt", "createdAt"
    from app.subscription_invoices where "businessId" = ${businessId}::uuid order by "createdAt" desc limit ${limit}
  `.execute(context.transaction);
  return result.rows;
}

// ---------------------------------------------------------------------
// Webhook-only functions - called from provider-events, which has no
// request-scoped caller identity, hence the security-definer functions.
// ---------------------------------------------------------------------

export interface ActivateSubscriptionInput {
  readonly businessId: string;
  readonly planCode: PlanCode;
  readonly subscriptionCode: string | null;
  readonly customerCode: string | null;
  readonly emailToken: string | null;
  readonly periodEnd: Date | null;
  readonly amountMinor: number | null;
  readonly providerReference: string;
}

export async function activateSubscription(context: DatabaseContext, input: ActivateSubscriptionInput): Promise<string> {
  const result = await sql<{ activate_business_subscription: string }>`
    select app.activate_business_subscription(
      ${input.businessId}::uuid, ${input.planCode}, ${input.subscriptionCode}, ${input.customerCode},
      ${input.emailToken}, ${input.periodEnd}, ${input.amountMinor}, ${input.providerReference}
    )
  `.execute(context.transaction);
  return result.rows[0]!.activate_business_subscription;
}

export async function recordRecurringPayment(context: DatabaseContext, subscriptionCode: string, amountMinor: number | null, periodEnd: Date | null, providerReference: string): Promise<boolean> {
  const result = await sql<{ record_recurring_subscription_payment: boolean }>`
    select app.record_recurring_subscription_payment(${subscriptionCode}, ${amountMinor}, ${periodEnd}, ${providerReference})
  `.execute(context.transaction);
  return result.rows[0]?.record_recurring_subscription_payment ?? false;
}

export async function setSubscriptionStatus(context: DatabaseContext, businessId: string, status: SubscriptionStatus, periodEnd: Date | null): Promise<boolean> {
  const result = await sql<{ set_business_subscription_status: boolean }>`
    select app.set_business_subscription_status(${businessId}::uuid, ${status}, ${periodEnd})
  `.execute(context.transaction);
  return result.rows[0]?.set_business_subscription_status ?? false;
}

export async function recordPaymentFailure(context: DatabaseContext, businessId: string, amountMinor: number | null, providerReference: string): Promise<string | null> {
  const result = await sql<{ record_subscription_payment_failure: string | null }>`
    select app.record_subscription_payment_failure(${businessId}::uuid, ${amountMinor}, ${providerReference})
  `.execute(context.transaction);
  return result.rows[0]?.record_subscription_payment_failure ?? null;
}

// ---------------------------------------------------------------------
// Dunning sweep (jobs domain handler) - also anonymous-caller, business-
// spanning by nature.
// ---------------------------------------------------------------------

export interface PastDueSubscription {
  readonly subscriptionId: string;
  readonly businessId: string;
  readonly lastFailureAt: Date;
  readonly reminderCount: number;
}

/** Every currently past_due subscription, with how long ago it first failed and how many reminders have gone out since - the dunning sweep's own inputs, computed from the append-only event log rather than duplicated state. Security definer: the anonymous sweep principal has no per-business subscription.read grant, so a plain query would see nothing under any business. */
export async function listPastDueSubscriptionsForDunning(context: DatabaseContext): Promise<PastDueSubscription[]> {
  const result = await sql<PastDueSubscription>`select * from app.list_past_due_subscriptions_for_dunning()`.execute(context.transaction);
  return result.rows;
}

/** Same anonymous-caller gap as above, this time against business_memberships (self-select only). */
export async function findBusinessOwnerEmail(context: DatabaseContext, businessId: string): Promise<string | undefined> {
  const result = await sql<{ find_business_owner_email: string | null }>`select app.find_business_owner_email(${businessId}::uuid)`.execute(context.transaction);
  return result.rows[0]?.find_business_owner_email ?? undefined;
}

export async function recordReminderSent(context: DatabaseContext, businessId: string, subscriptionId: string, metadata: Record<string, unknown>): Promise<void> {
  await sql`
    insert into app.subscription_dunning_events ("businessId", "subscriptionId", "kind", "metadata")
    values (${businessId}::uuid, ${subscriptionId}::uuid, 'reminder_sent', ${JSON.stringify(metadata)}::jsonb)
  `.execute(context.transaction);
}

/** Reuses the same security-definer status-transition function the webhook path calls - the sweep runs anonymously too, and app.business_subscriptions' own UPDATE policy requires subscription.manage, which no anonymous caller has. */
export async function expireGracePeriod(context: DatabaseContext, businessId: string, subscriptionId: string): Promise<void> {
  await setSubscriptionStatus(context, businessId, "expired", null);
  await sql`
    insert into app.subscription_dunning_events ("businessId", "subscriptionId", "kind") values (${businessId}::uuid, ${subscriptionId}::uuid, 'grace_period_expired')
  `.execute(context.transaction);
}
