/**
 * Business Subscription Service
 * Handles subscription management with Paystack integration
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { supabase as publicSupabase } from "../config/supabase";
import supabaseAdmin from "../config/supabaseAdmin";
import {
  BusinessSubscription,
  SubscriptionPlan,
  SubscriptionStatus,
  InitiateSubscriptionResponse,
  Invoice,
  UsageReport,
} from "../types/subscription";
import { planLimitsService } from "./plan-limits.service";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;
const PAYSTACK_BASE_URL = "https://api.paystack.co";

export class BusinessSubscriptionService {
  private supabase: SupabaseClient;

  constructor(supabase?: SupabaseClient) {
    this.supabase = supabase || publicSupabase;
  }

  /**
   * Get subscription details for a business
   */
  async getSubscription(businessId: string): Promise<BusinessSubscription> {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select(
        "subscription_plan, subscription_status, subscription_started_at, subscription_expires_at, subscription_meta",
      )
      .eq("id", businessId)
      .single();

    if (error) throw error;
    if (!business) throw new Error("Business not found");

    const plan = (business.subscription_plan || "starter") as SubscriptionPlan;
    const status = business.subscription_status as SubscriptionStatus;
    const meta = (business.subscription_meta || {}) as Record<string, any>;

    return {
      plan,
      status,
      started_at: business.subscription_started_at,
      expires_at: business.subscription_expires_at,
      next_payment_date:
        meta.next_payment_date || business.subscription_expires_at,
      can_cancel: status === "active" && plan !== "starter",
    };
  }

  /**
   * Initiate a new subscription via Paystack
   */
  async initiateSubscription(
    businessId: string,
    plan: "plus" | "pro",
    userEmail: string,
    userId: string,
    callbackUrl?: string,
  ): Promise<InitiateSubscriptionResponse> {
    // Get plan config
    const planConfig = await planLimitsService.getPlanConfig(plan);
    if (!planConfig || !planConfig.paystack_plan_code) {
      throw new Error(`Plan ${plan} is not available for subscription`);
    }

    // Get business info
    const { data: business } = await this.supabase
      .from("businesses")
      .select("name")
      .eq("id", businessId)
      .single();

    // Generate unique reference
    const reference = createTransactionReference(REFERENCE_TYPES.SUBSCRIPTION);

    // Attach reference to callback URL if provided to ensure it's available on redirect
    const finalCallbackUrl = callbackUrl
      ? `${callbackUrl}${callbackUrl.includes("?") ? "&" : "?"}reference=${reference}`
      : undefined;

    // Initialize Paystack subscription
    const response = await fetch(
      `${PAYSTACK_BASE_URL}/transaction/initialize`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: userEmail,
          amount: planConfig.price_monthly,
          reference,
          plan: planConfig.paystack_plan_code,
          callback_url: finalCallbackUrl,
          metadata: {
            business_id: businessId,
            business_name: business?.name,
            user_id: userId,
            plan,
            transaction_type: "business_subscription",
            custom_fields: [
              {
                display_name: "Business",
                variable_name: "business_name",
                value: business?.name || "Unknown",
              },
              {
                display_name: "Plan",
                variable_name: "plan_name",
                value: plan.toUpperCase(),
              },
            ],
          },
        }),
      },
    );

    const result = (await response.json()) as {
      status: boolean;
      message?: string;
      data?: { authorization_url: string; reference: string };
    };

    if (!result.status) {
      console.error("[BusinessSubscription] Paystack error:", result);
      throw new Error(result.message || "Failed to initiate subscription");
    }

    return {
      authorization_url: result.data!.authorization_url,
      reference: result.data!.reference,
    };
  }

  /**
   * Cancel a business subscription
   */
  async cancelSubscription(businessId: string): Promise<void> {
    const { data: business, error } = await this.supabase
      .from("businesses")
      .select("subscription_reference, subscription_meta")
      .eq("id", businessId)
      .single();

    if (error) throw error;

    const subscriptionCode = business?.subscription_reference;
    const meta = (business?.subscription_meta || {}) as Record<string, any>;

    // Call Paystack to disable subscription if we have a code
    if (subscriptionCode && meta.email_token) {
      try {
        const response = await fetch(
          `${PAYSTACK_BASE_URL}/subscription/disable`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              code: subscriptionCode,
              token: meta.email_token,
            }),
          },
        );

        const result = (await response.json()) as {
          status: boolean;
          message?: string;
        };
        if (!result.status) {
          console.warn(
            "[BusinessSubscription] Paystack disable warning:",
            result,
          );
        }
      } catch (err) {
        console.error("[BusinessSubscription] Paystack disable error:", err);
      }
    }

    // Update business record
    const adminClient = supabaseAdmin || this.supabase;
    const { error: updateError } = await adminClient
      .from("businesses")
      .update({
        subscription_status: "cancelled",
        subscription_updated_at: new Date().toISOString(),
        subscription_meta: {
          ...meta,
          cancelled_at: new Date().toISOString(),
          cancel_reason: "user_requested",
        },
      })
      .eq("id", businessId);

    if (updateError) throw updateError;
  }

  /**
   * Internal helper to activate a business subscription and send emails
   */
  private async activateBusinessSubscription(
    businessId: string,
    data: any,
    adminClient: SupabaseClient,
    now: string,
  ): Promise<void> {
    const plan = data.metadata?.plan || "plus";
    const nextPaymentDate =
      data.next_payment_date || data.metadata?.next_payment_date;
    const subscriptionCode = data.subscription_code;

    await adminClient
      .from("businesses")
      .update({
        subscription_plan: plan,
        subscription_status: "active",
        subscription_reference: subscriptionCode,
        subscription_started_at: now,
        subscription_updated_at: now,
        subscription_expires_at: nextPaymentDate,
        subscription_meta: {
          paystack_subscription_code: subscriptionCode,
          paystack_customer_code: data.customer?.customer_code,
          email_token: data.email_token,
          next_payment_date: nextPaymentDate,
          plan_code: data.plan?.plan_code || data.metadata?.plan_code,
        },
      })
      .eq("id", businessId);

    // Send confirmation email
    try {
      const { emailService } = await import("./email.service");
      const { data: user } = await adminClient
        .from("users")
        .select("email, full_name")
        .eq("id", data.metadata?.user_id)
        .single();

      if (user?.email) {
        await emailService.sendMembershipEmail({
          userEmail: user.email,
          userName: user.full_name || "Business Owner",
          planId: plan,
        });
      }
    } catch (err) {
      console.error(
        "[BusinessSubscription] Failed to send upgrade email:",
        err,
      );
    }
  }

  /**
   * Change subscription plan (upgrade/downgrade)
   */
  async changePlan(
    businessId: string,
    newPlan: "plus" | "pro",
    userEmail: string,
    userId: string,
    callbackUrl?: string,
  ): Promise<InitiateSubscriptionResponse> {
    // Cancel-and-restart — no proration until Paystack supports mid-cycle upgrades

    // First cancel existing subscription
    await this.cancelSubscription(businessId);

    // Then initiate new subscription
    return this.initiateSubscription(
      businessId,
      newPlan,
      userEmail,
      userId,
      callbackUrl,
    );
  }

  /**
   * Get usage counts vs limits (extended format for frontend gating)
   */
  async getUsage(businessId: string): Promise<{
    plan: string;
    resources: Record<
      string,
      {
        used: number;
        limit: number | "unlimited";
        available: number | "unlimited";
      }
    >;
    features: Record<string, any>;
  }> {
    const { PlanLimitsService } = await import("./plan-limits.service");
    const planLimits = new PlanLimitsService(this.supabase);
    const report = await planLimits.getExtendedUsageReport(businessId);
    return {
      plan: report.plan,
      resources: report.resources,
      features: report.features as unknown as Record<string, any>,
    };
  }

  /**
   * Get invoice/payment history from Paystack
   */
  async getInvoices(businessId: string): Promise<Invoice[]> {
    const { data: business } = await this.supabase
      .from("businesses")
      .select("subscription_meta, owner_user_id")
      .eq("id", businessId)
      .single();

    const meta = (business?.subscription_meta || {}) as Record<string, any>;
    const customerCode = meta.paystack_customer_code;

    if (!customerCode) {
      return [];
    }

    try {
      const response = await fetch(
        `${PAYSTACK_BASE_URL}/transaction?customer=${customerCode}&status=success`,
        {
          headers: {
            Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
          },
        },
      );

      const result = (await response.json()) as {
        status: boolean;
        data?: any[];
      };

      if (!result.status || !result.data) {
        return [];
      }

      return result.data.map((tx: any) => ({
        id: tx.id.toString(),
        amount: tx.amount / 100, // Convert from kobo
        currency: tx.currency,
        status: tx.status,
        paid_at: tx.paid_at,
        created_at: tx.created_at,
        description: tx.metadata?.plan_name
          ? `${tx.metadata.plan_name} Plan Subscription`
          : "Subscription Payment",
      }));
    } catch (err) {
      console.error("[BusinessSubscription] Error fetching invoices:", err);
      return [];
    }
  }

  /**
   * Handle webhook events from Paystack
   */
  async handleSubscriptionWebhook(
    event: string,
    data: any,
  ): Promise<{ success: boolean; message: string }> {
    const businessId = data.metadata?.business_id;

    if (!businessId) {
      console.warn(
        "[BusinessSubscription] Webhook missing business_id:",
        event,
      );
      return { success: false, message: "Missing business_id in metadata" };
    }

    const adminClient = supabaseAdmin || this.supabase;
    const now = new Date().toISOString();

    console.log(
      `[BusinessSubscription] Handling event: ${event} for business: ${businessId}`,
      {
        reference: data.reference,
        subscription_code: data.subscription_code,
        plan: data.metadata?.plan,
      },
    );

    switch (event) {
      case "subscription.create": {
        await this.activateBusinessSubscription(
          businessId,
          data,
          adminClient,
          now,
        );
        return { success: true, message: "Subscription activated" };
      }

      case "subscription.enable": {
        await adminClient
          .from("businesses")
          .update({
            subscription_status: "active",
            subscription_updated_at: now,
          })
          .eq("id", businessId);

        return { success: true, message: "Subscription enabled" };
      }

      case "subscription.disable": {
        await adminClient
          .from("businesses")
          .update({
            subscription_status: "cancelled",
            subscription_updated_at: now,
          })
          .eq("id", businessId);

        return { success: true, message: "Subscription disabled" };
      }

      case "charge.success": {
        // Recurring payment successful
        const plan = data.metadata?.plan;
        const subscriptionCode = data.subscription_code;

        if (subscriptionCode && plan) {
          // If we have subscription info, treat as activation/sync
          await this.activateBusinessSubscription(
            businessId,
            data,
            adminClient,
            now,
          );
        } else {
          const nextPaymentDate = data.metadata?.next_payment_date;
          await adminClient
            .from("businesses")
            .update({
              subscription_status: "active",
              subscription_updated_at: now,
              subscription_expires_at: nextPaymentDate || null,
            })
            .eq("id", businessId);
        }

        return { success: true, message: "Payment confirmed" };
      }

      case "subscription.not_renew": {
        // User cancelled, but subscription still active until period end
        const expiresAt = data.next_payment_date || data.cancelledAt;

        await adminClient
          .from("businesses")
          .update({
            subscription_status: "cancelled",
            subscription_expires_at: expiresAt,
            subscription_updated_at: now,
          })
          .eq("id", businessId);

        return { success: true, message: "Subscription will not renew" };
      }

      case "invoice.payment_failed": {
        await adminClient
          .from("businesses")
          .update({
            subscription_status: "past_due",
            subscription_updated_at: now,
          })
          .eq("id", businessId);

        // TODO: Send notification email to business owner

        return { success: true, message: "Payment failed recorded" };
      }

      case "direct_debit.authorization.created": {
        // Log entry for audit, maybe update status to setup_complete if needed
        console.log(
          `[BusinessSubscription] Direct debit authorized for business: ${businessId}`,
        );
        return { success: true, message: "Direct debit authorized" };
      }

      default:
        return { success: false, message: `Unhandled event: ${event}` };
    }
  }

  /**
   * Activate subscription (called after successful payment, for testing/manual)
   */
  async activateSubscription(
    businessId: string,
    plan: SubscriptionPlan,
    reference: string,
    expiresAt?: string,
  ): Promise<void> {
    const adminClient = supabaseAdmin || this.supabase;
    const now = new Date().toISOString();

    await adminClient
      .from("businesses")
      .update({
        subscription_plan: plan,
        subscription_status: "active",
        subscription_reference: reference,
        subscription_started_at: now,
        subscription_updated_at: now,
        subscription_expires_at: expiresAt || null,
      })
      .eq("id", businessId);
  }

  /**
   * Downgrade to starter (called by expiration job)
   */
  async downgradeToStarter(businessId: string): Promise<void> {
    const adminClient = supabaseAdmin || this.supabase;

    await adminClient
      .from("businesses")
      .update({
        subscription_plan: "starter",
        subscription_status: "expired",
        subscription_updated_at: new Date().toISOString(),
      })
      .eq("id", businessId);
  }
}

// Singleton instance
export const businessSubscriptionService = new BusinessSubscriptionService();
