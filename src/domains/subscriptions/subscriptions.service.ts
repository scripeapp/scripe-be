import { randomUUID } from "node:crypto";
import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { getSubscriptionBillingGateway } from "../../integrations/subscription-billing.js";
import { emailSender } from "../../shared/email.js";
import { AppError, conflictError, notFoundError, validationError } from "../../shared/errors.js";
import * as auditRepository from "../audit/audit.repository.js";
import * as authorizationRepository from "../authorization/authorization.repository.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./subscriptions.repository.js";
import type { PastDueSubscription } from "./subscriptions.repository.js";
import type {
  BusinessSubscription,
  BusinessSubscriptionRow,
  InitiateSubscriptionInput,
  InitiatedSubscription,
  Plan,
  PlanEntitlement,
  PlansOperation,
  ResolvedEntitlement,
  SubscriptionInvoice,
  SubscriptionInvoiceRow,
  SubscriptionsOperation,
  UsageReportEntry,
} from "./subscriptions.types.js";

const DUNNING_GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const DUNNING_REMINDER_INTERVAL_MS = 2 * 24 * 60 * 60 * 1000;
const MAX_DUNNING_REMINDERS = 3;

export class SubscriptionsService {
  constructor(private readonly database: Database) {}

  async listPlans(operation: PlansOperation): Promise<{ plans: Plan[]; entitlements: Record<string, PlanEntitlement[]> }> {
    return withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, null), async (context) => {
      const plans = await repository.listPlans(context);
      const entitlements: Record<string, PlanEntitlement[]> = {};
      for (const plan of plans) {
        entitlements[plan.code] = await repository.listPlanEntitlements(context, plan.code);
      }
      return { plans, entitlements };
    });
  }

  async getSubscription(operation: SubscriptionsOperation): Promise<BusinessSubscription> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "subscription.read");
      const current = await repository.findMostRecentSubscription(context, operation.businessId);
      if (!current) return starterSubscription(operation.businessId);
      return toSubscription(current);
    });
  }

  async getUsage(operation: SubscriptionsOperation): Promise<UsageReportEntry[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "subscription.read");
      const members = await authorizationRepository.listMembers(context, operation.businessId);
      const activeMembers = members.filter((member) => member.status === "active").length;
      const teamLimit = await resolveEntitlement(context, operation.businessId, "team_members");
      return [{ key: "team_members", used: activeMembers, limit: teamLimit.limitValue, unlimited: teamLimit.unlimited }];
    });
  }

  async getInvoices(operation: SubscriptionsOperation): Promise<SubscriptionInvoice[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "subscription.read");
      const rows = await repository.listInvoices(context, operation.businessId, 50);
      return rows.map(toInvoice);
    });
  }

  async initiateSubscription(operation: SubscriptionsOperation, input: InitiateSubscriptionInput): Promise<InitiatedSubscription> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "subscription.manage");
      const plan = await repository.findPlan(context, input.plan);
      if (!plan?.paystackPlanCode) throw validationError(`Plan "${input.plan}" is not available for subscription`);

      const email = await repository.findUserEmail(context, operation.userId);
      if (!email) throw validationError("No account email found for the requesting user");

      const reference = `sub_${randomUUID()}`;
      const gateway = getSubscriptionBillingGateway();
      const checkout = await gateway.initializeSubscription({
        email,
        planCode: plan.paystackPlanCode,
        reference,
        callbackUrl: input.callbackUrl,
        metadata: { transaction_type: "business_subscription", business_id: operation.businessId, user_id: operation.userId, plan: input.plan },
      });

      await auditRepository.log(context, {
        businessId: operation.businessId,
        actorUserId: operation.userId,
        action: "subscriptions.initiate",
        targetType: "business_subscription",
        targetId: null,
        metadata: { plan: input.plan, reference: checkout.reference },
        requestId: operation.requestId,
      });

      return checkout;
    });
  }

  async cancelSubscription(operation: SubscriptionsOperation): Promise<void> {
    const current = await this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "subscription.manage");
      const found = await repository.findCurrentSubscription(context, operation.businessId);
      if (!found) throw notFoundError("No active subscription to cancel");
      if (found.planCode === "starter") throw conflictError("The starter plan cannot be cancelled");
      return found;
    });

    if (current.providerSubscriptionCode && current.providerEmailToken) {
      const gateway = getSubscriptionBillingGateway();
      try {
        await gateway.disableSubscription({ subscriptionCode: current.providerSubscriptionCode, emailToken: current.providerEmailToken });
      } catch (error) {
        console.error("[subscriptions] Paystack disable failed, cancelling locally anyway", error);
      }
    }

    await this.run(operation, async (context) => {
      await repository.setSubscriptionStatus(context, operation.businessId, "cancelled", current.currentPeriodEndsAt);
      await auditRepository.log(context, {
        businessId: operation.businessId,
        actorUserId: operation.userId,
        action: "subscriptions.cancel",
        targetType: "business_subscription",
        targetId: current.id,
        requestId: operation.requestId,
      });
    });
  }

  private async run<T>(operation: SubscriptionsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

/**
 * Resolves a plan-limit entitlement, for any domain to call directly - the
 * same "exported standalone function" shape as risk's hasActiveHold/
 * recordSignal and platform's requirePlatformAdministrator. A row-absent
 * limit is unlimited.
 */
export async function checkLimit(context: DatabaseContext, businessId: string, key: string, currentUsage: number): Promise<void> {
  const resolved = await resolveEntitlement(context, businessId, key);
  if (resolved.unlimited) return;
  if (resolved.limitValue !== null && currentUsage >= resolved.limitValue) {
    throw validationError(`This business's plan allows up to ${resolved.limitValue} ${key.replace(/_/g, " ")}; upgrade to add more.`);
  }
}

export async function hasFeature(context: DatabaseContext, businessId: string, key: string): Promise<boolean> {
  const resolved = await resolveEntitlement(context, businessId, key);
  return resolved.featureEnabled;
}

async function resolveEntitlement(context: DatabaseContext, businessId: string, key: string): Promise<ResolvedEntitlement> {
  const row = await repository.resolveEntitlement(context, businessId, key);
  if (row.kind === "limit") return { key, kind: "limit", limitValue: Number(row.limitValue), unlimited: false, featureEnabled: false };
  if (row.kind === "feature") return { key, kind: "feature", limitValue: null, unlimited: false, featureEnabled: row.featureEnabled ?? false };
  // No row for this key on the business's plan: a limit defaults to
  // unlimited, a feature defaults to disabled - the caller only knows which
  // convention applies by which kind of check it's making, so both are
  // expressed here and the caller (checkLimit vs hasFeature) picks.
  return { key, kind: null, limitValue: null, unlimited: true, featureEnabled: false };
}

// ---------------------------------------------------------------------
// Webhook handlers - called from provider-events, anonymous principal.
// ---------------------------------------------------------------------

export interface SubscriptionWebhookEvent {
  readonly type: string;
  readonly businessId: string | null;
  readonly planCode: "plus" | "pro" | null;
  readonly subscriptionCode: string | null;
  readonly customerCode: string | null;
  readonly emailToken: string | null;
  readonly periodEnd: Date | null;
  readonly amountMinor: number | null;
  readonly providerReference: string | null;
}

/** Mirrors legacy's handleSubscriptionWebhook switch, ported to this domain's security-definer functions. */
export async function handleSubscriptionWebhook(context: DatabaseContext, event: SubscriptionWebhookEvent): Promise<"processed" | "ignored"> {
  if (!event.businessId) return "ignored";

  switch (event.type) {
    case "subscription.create": {
      if (!event.planCode) return "ignored";
      await repository.activateSubscription(context, {
        businessId: event.businessId,
        planCode: event.planCode,
        subscriptionCode: event.subscriptionCode,
        customerCode: event.customerCode,
        emailToken: event.emailToken,
        periodEnd: event.periodEnd,
        amountMinor: event.amountMinor,
        providerReference: event.providerReference ?? event.subscriptionCode ?? randomUUID(),
      });
      return "processed";
    }
    case "charge.success": {
      if (event.subscriptionCode && event.planCode) {
        const recovered = await repository.recordRecurringPayment(context, event.subscriptionCode, event.amountMinor, event.periodEnd, event.providerReference ?? randomUUID());
        if (recovered) return "processed";
        // No existing subscription for this code yet - first payment.
        await repository.activateSubscription(context, {
          businessId: event.businessId,
          planCode: event.planCode,
          subscriptionCode: event.subscriptionCode,
          customerCode: event.customerCode,
          emailToken: event.emailToken,
          periodEnd: event.periodEnd,
          amountMinor: event.amountMinor,
          providerReference: event.providerReference ?? event.subscriptionCode,
        });
        return "processed";
      }
      const found = await repository.setSubscriptionStatus(context, event.businessId, "active", event.periodEnd);
      return found ? "processed" : "ignored";
    }
    case "subscription.enable": {
      const found = await repository.setSubscriptionStatus(context, event.businessId, "active", null);
      return found ? "processed" : "ignored";
    }
    case "subscription.disable": {
      const found = await repository.setSubscriptionStatus(context, event.businessId, "cancelled", null);
      return found ? "processed" : "ignored";
    }
    case "subscription.not_renew": {
      const found = await repository.setSubscriptionStatus(context, event.businessId, "cancelled", event.periodEnd);
      return found ? "processed" : "ignored";
    }
    case "invoice.payment_failed": {
      const subscriptionId = await repository.recordPaymentFailure(context, event.businessId, event.amountMinor, event.providerReference ?? randomUUID());
      return subscriptionId ? "processed" : "ignored";
    }
    default:
      return "ignored";
  }
}

// ---------------------------------------------------------------------
// Dunning sweep - the jobs domain's built-in "subscriptions.dunning_check"
// recurring handler calls this. Legacy's invoice.payment_failed handler set
// status=past_due with a bare "TODO: Send notification email to business
// owner" and never implemented it; the only real enforcement was one cron
// (businessSubscriptionExpiryJob) with no reminders at all in between. This
// is that TODO, actually built: reminder emails during a 7-day grace
// period, then a real downgrade if it lapses.
// ---------------------------------------------------------------------

export async function runDunningSweep(context: DatabaseContext): Promise<{ remindersSent: number; expired: number }> {
  const pastDue = await repository.listPastDueSubscriptionsForDunning(context);
  let remindersSent = 0;
  let expired = 0;

  for (const subscription of pastDue) {
    const outcome = await processDunningSubscription(context, subscription);
    if (outcome === "reminded") remindersSent += 1;
    if (outcome === "expired") expired += 1;
  }

  return { remindersSent, expired };
}

async function processDunningSubscription(context: DatabaseContext, subscription: PastDueSubscription): Promise<"reminded" | "expired" | "waiting"> {
  const failedForMs = Date.now() - subscription.lastFailureAt.getTime();

  if (failedForMs >= DUNNING_GRACE_PERIOD_MS) {
    await repository.expireGracePeriod(context, subscription.businessId, subscription.subscriptionId);
    return "expired";
  }

  const dueForReminder = subscription.reminderCount < MAX_DUNNING_REMINDERS && failedForMs >= subscription.reminderCount * DUNNING_REMINDER_INTERVAL_MS;
  if (!dueForReminder) return "waiting";

  const email = await repository.findBusinessOwnerEmail(context, subscription.businessId);
  if (email) {
    const graceDaysLeft = Math.max(0, Math.ceil((DUNNING_GRACE_PERIOD_MS - failedForMs) / (24 * 60 * 60 * 1000)));
    await emailSender.sendTransactional({
      to: email,
      subject: "Action needed: your Scripe subscription payment failed",
      html: `<p>We couldn't process your latest Scripe subscription payment.</p><p>Please update your payment method within ${graceDaysLeft} day(s) to avoid being downgraded to the free Starter plan.</p>`,
    });
  }
  await repository.recordReminderSent(context, subscription.businessId, subscription.subscriptionId, { reminderNumber: subscription.reminderCount + 1 });
  return "reminded";
}

function starterSubscription(businessId: string): BusinessSubscription {
  const now = new Date().toISOString();
  return {
    id: "starter",
    businessId,
    planCode: "starter",
    status: "active",
    providerSubscriptionCode: null,
    providerCustomerCode: null,
    providerEmailToken: null,
    startedAt: now,
    currentPeriodEndsAt: null,
    cancelledAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
    canCancel: false,
  };
}

function toSubscription(row: BusinessSubscriptionRow): BusinessSubscription {
  return {
    ...row,
    startedAt: row.startedAt.toISOString(),
    currentPeriodEndsAt: row.currentPeriodEndsAt?.toISOString() ?? null,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    canCancel: row.status !== "cancelled" && row.planCode !== "starter",
  };
}

function toInvoice(row: SubscriptionInvoiceRow): SubscriptionInvoice {
  return {
    ...row,
    periodStart: row.periodStart?.toISOString() ?? null,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    paidAt: row.paidAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
