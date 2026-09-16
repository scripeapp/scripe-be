/**
 * Publication Subscription Service
 * Handles subscription business logic for paid publications
 */

import { SupabaseClient } from "@supabase/supabase-js";
import type { FeeBearer } from "../types/payment";
import { supabaseAdmin } from "../config/supabase";
import { emailService } from "./email.service";
import { NotificationUtil } from "../utils/notification.util";
import { wrapInBaseEmail } from "../utils/email/BaseEmail";
import { SUPPORTED_CURRENCIES } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { resolvePaymentAmount } from "../utils/currency-rates.util";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";

// Platform fee percentage (10% by default)
const PLATFORM_FEE_PERCENT = parseFloat(
  process.env.PUBLICATION_SUBSCRIPTION_FEE_PERCENT || "10",
);

export interface SubscriptionPlan {
  plan: "free" | "monthly" | "yearly";
}

export interface MonetizationSettings {
  enabled: boolean;
  monthly_price: number; // in kobo
  yearly_price: number; // in kobo
  currency: string;
  fee_bearer: "subaccount" | "customer";
}

export interface Subscription {
  id: string;
  publication_id: string;
  user_id: string;
  subscription_type: "free" | "paid";
  plan: "monthly" | "yearly" | null;
  status: "active" | "cancelled" | "expired";
  current_period_end: string | null;
  paystack_subscription_code: string | null;
  cancelled_at: string | null;
  subscribed_at: string;
}

class PublicationSubscriptionService {
  /**
   * Subscribe a user to a publication
   * Returns payment URL for paid plans, or subscription for free plans
   */
  async subscribe(
    supabaseClient: SupabaseClient,
    userId: string,
    publicationId: string,
    plan: "free" | "monthly" | "yearly",
    currency: string = "NGN",
  ): Promise<{
    subscription?: Subscription;
    payment_url?: string;
    payment_reference?: string;
  }> {
    // 1. Get publication with monetization settings
    const { data: publication, error: pubError } = await supabaseClient
      .from("publications")
      .select("id, user_id, business_id, name, monetization")
      .eq("id", publicationId)
      .single();

    if (pubError || !publication) {
      throw new Error("Newsletter not found");
    }

    // 2. Check if user is the owner (not allowed to subscribe to own publication)
    if (publication.user_id === userId) {
      throw new Error("Cannot subscribe to your own newsletter");
    }

    // 3. Check if user is already subscribed
    const { data: existingSub } = await supabaseClient
      .from("subscriptions")
      .select("*")
      .eq("publication_id", publicationId)
      .eq("user_id", userId)
      .single();

    if (existingSub && existingSub.status === "active") {
      // If upgrading from free to paid
      if (existingSub.subscription_type === "free" && plan !== "free") {
        // Allow upgrade - will be handled below
      } else if (plan === "free") {
        throw new Error("Already subscribed to this newsletter");
      }
    }

    // 4. Handle free subscription
    if (plan === "free") {
      return this.createFreeSubscription(
        supabaseClient,
        userId,
        publicationId,
        existingSub?.id,
      );
    }

    // 5. Handle paid subscription
    const monetization =
      publication.monetization as MonetizationSettings | null;
    if (!monetization?.enabled) {
      throw new Error("This newsletter does not accept paid subscriptions");
    }

    const price =
      plan === "monthly"
        ? monetization.monthly_price
        : monetization.yearly_price;
    if (!price || price <= 0) {
      throw new Error(`${plan} plan is not available for this newsletter`);
    }

    // 6. Resolve subaccounts — both Paystack and Flutterwave
    let subaccountCode: string | undefined;
    let flwSubaccountId: string | undefined;

    if (publication.business_id) {
      const { data: business } = await supabaseAdmin
        .from("businesses")
        .select("paystack_subaccount_code, flw_subaccount_id")
        .eq("id", publication.business_id)
        .single();

      subaccountCode = business?.paystack_subaccount_code;
      flwSubaccountId = business?.flw_subaccount_id ?? undefined;
    }


    // 7. Initialize payment via factory (NGN → Paystack, others → Flutterwave)
    const safeCurrency: SupportedCurrency = (SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
      ? (currency as SupportedCurrency)
      : "NGN";

    const { PaymentProviderFactory } = await import(
      "../utils/payment/PaymentProviderFactory"
    );

    if (safeCurrency !== "NGN" && !flwSubaccountId) {
      throw Object.assign(
        new Error("This creator has not set up multi-currency payments yet."),
        { statusCode: 422 },
      );
    }

    // price is in kobo; providers expect major units
    const priceInMajorUnit = price / 100;
    // Convert base NGN price to buyer's chosen currency using live FLW rates.
    const chargeAmount = await resolvePaymentAmount(priceInMajorUnit, safeCurrency);
    const provider = PaymentProviderFactory.getProvider(safeCurrency);

    // Subscriber pays exactly the converted amount — no fee gross-up.
    // Hilaq + provider combined take PLATFORM_FEE_PERCENT (10%), guaranteeing creator nets 90%.
    // For Paystack: transactionCharge = totalFee - paystackFee (so creator deduction = exactly 10%).
    // For FLW: flwMerchantAmount = chargeAmount × 90% (FLW takes its fee from Hilaq's remainder).
    const totalFee = Number((chargeAmount * (PLATFORM_FEE_PERCENT / 100)).toFixed(2));
    const paystackFee = Math.min(chargeAmount * 0.015 + (chargeAmount >= 2500 ? 100 : 0), 2000);
    const platformFee = Math.max(Number((totalFee - paystackFee).toFixed(2)), 0);

    const reference = createTransactionReference(REFERENCE_TYPES.SUBSCRIPTION);

    const userEmail = await this.getUserEmail(supabaseClient, userId);

    const result = await provider.initializePayment({
      amount: chargeAmount,
      email: userEmail,
      currency: safeCurrency,
      reference,
      metadata: {
        subscription_type: "publication",
        publication_id: publicationId,
        publication_name: publication.name,
        user_id: userId,
        plan,
        existing_subscription_id: existingSub?.id,
      },
      // Paystack-specific split fields (ignored by Flutterwave)
      subaccountCode,
      bearer: (monetization.fee_bearer as FeeBearer) || "subaccount",
      transactionCharge: Math.round(platformFee * 100),
      // Flutterwave-specific split fields (ignored by Paystack)
      flwSubaccountId,
      flwMerchantAmount: Number((chargeAmount * (1 - PLATFORM_FEE_PERCENT / 100)).toFixed(2)),
    });

    // 8. Create pending subscription payment record
    if (existingSub) {
      await supabaseAdmin.from("subscription_payments").insert({
        subscription_id: existingSub.id,
        amount: price,
        currency: safeCurrency,
        paystack_reference: reference,
        status: "pending",
      });
    }

    return {
      payment_url: result.authorization_url,
      payment_reference: result.reference,
    };
  }

  /**
   * Create a free subscription
   */
  private async createFreeSubscription(
    supabaseClient: SupabaseClient,
    userId: string,
    publicationId: string,
    existingSubId?: string,
  ): Promise<{ subscription: Subscription }> {
    const subscriptionData = {
      publication_id: publicationId,
      user_id: userId,
      subscription_type: "free",
      plan: null,
      status: "active",
      current_period_end: null,
      subscribed_at: new Date().toISOString(),
    };

    if (existingSubId) {
      // Update existing subscription
      const { data, error } = await supabaseClient
        .from("subscriptions")
        .update(subscriptionData)
        .eq("id", existingSubId)
        .select()
        .single();

      if (error) throw error;
      return { subscription: data };
    }

    // Create new subscription
    const { data, error } = await supabaseClient
      .from("subscriptions")
      .insert(subscriptionData)
      .select()
      .single();

    if (error) throw error;

    // Notify publication owner
    await this.sendNewSubscriberNotification(publicationId, userId, "Free");

    return { subscription: data };
  }

  /**
   * Activate a paid subscription after successful payment
   */
  async activatePaidSubscription(
    publicationId: string,
    userId: string,
    plan: "monthly" | "yearly",
    paystackReference: string,
    paystackSubscriptionCode?: string,
    existingSubscriptionId?: string,
  ): Promise<Subscription> {
    const now = new Date();
    const periodEnd = new Date(now);

    if (plan === "monthly") {
      periodEnd.setMonth(periodEnd.getMonth() + 1);
    } else {
      periodEnd.setFullYear(periodEnd.getFullYear() + 1);
    }

    const subscriptionData = {
      publication_id: publicationId,
      user_id: userId,
      subscription_type: "paid",
      plan,
      status: "active",
      current_period_end: periodEnd.toISOString(),
      paystack_subscription_code: paystackSubscriptionCode || null,
      subscribed_at: now.toISOString(),
      cancelled_at: null, // Clear any previous cancellation
    };

    let subscription: Subscription;

    if (existingSubscriptionId) {
      // Update existing subscription
      const { data, error } = await supabaseAdmin
        .from("subscriptions")
        .update(subscriptionData)
        .eq("id", existingSubscriptionId)
        .select()
        .single();

      if (error) throw error;
      subscription = data;
    } else {
      // Check for existing subscription first
      const { data: existing } = await supabaseAdmin
        .from("subscriptions")
        .select("id")
        .eq("publication_id", publicationId)
        .eq("user_id", userId)
        .single();

      if (existing) {
        const { data, error } = await supabaseAdmin
          .from("subscriptions")
          .update(subscriptionData)
          .eq("id", existing.id)
          .select()
          .single();

        if (error) throw error;
        subscription = data;
      } else {
        const { data, error } = await supabaseAdmin
          .from("subscriptions")
          .insert(subscriptionData)
          .select()
          .single();

        if (error) throw error;
        subscription = data;
      }
    }

    // Update payment record to success if exists
    await supabaseAdmin
      .from("subscription_payments")
      .update({ status: "success", processed_at: now.toISOString() })
      .eq("paystack_reference", paystackReference);

    // Notify publication owner
    await this.sendNewSubscriberNotification(
      publicationId,
      userId,
      plan === "yearly" ? "Yearly" : "Monthly",
    );

    return subscription;
  }

  /**
   * Get a user's subscription to a publication
   */
  async getSubscription(
    supabaseClient: SupabaseClient,
    userId: string,
    publicationId: string,
  ): Promise<Subscription | null> {
    const { data, error } = await supabaseClient
      .from("subscriptions")
      .select("*")
      .eq("publication_id", publicationId)
      .eq("user_id", userId)
      .single();

    if (error && error.code !== "PGRST116") {
      throw error;
    }

    return data;
  }

  /**
   * Cancel a subscription (access until period end)
   */
  async cancelSubscription(
    supabaseClient: SupabaseClient,
    subscriptionId: string,
    userId: string,
  ): Promise<{ cancelled_at: string; access_until: string | null }> {
    // Verify ownership
    const { data: subscription, error: fetchError } = await supabaseClient
      .from("subscriptions")
      .select("*")
      .eq("id", subscriptionId)
      .eq("user_id", userId)
      .single();

    if (fetchError || !subscription) {
      throw new Error("Subscription not found");
    }

    if (subscription.status !== "active") {
      throw new Error("Subscription is not active");
    }

    const cancelledAt = new Date().toISOString();

    // For free subscriptions, cancel immediately (expire)
    // For paid subscriptions, keep access until period end
    const newStatus =
      subscription.subscription_type === "free" ? "expired" : "cancelled";

    const { error: updateError } = await supabaseClient
      .from("subscriptions")
      .update({
        status: newStatus,
        cancelled_at: cancelledAt,
      })
      .eq("id", subscriptionId);

    if (updateError) throw updateError;

    return {
      cancelled_at: cancelledAt,
      access_until: subscription.current_period_end,
    };
  }

  /**
   * Get all subscriptions for a user
   */
  async getUserSubscriptions(
    supabaseClient: SupabaseClient,
    userId: string,
  ): Promise<(Subscription & { publication: any })[]> {
    const { data, error } = await supabaseClient
      .from("subscriptions")
      .select(
        `
        *,
        publication:publication_id(id, name, description, profile_image, user_id, monetization)
      `,
      )
      .eq("user_id", userId)
      .order("subscribed_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  /**
   * Check if user can access a specific post based on visibility
   */
  async canAccessPost(
    userId: string | null,
    post: { publication: string; visibility: string },
  ): Promise<boolean> {
    // Public posts are always accessible
    if (post.visibility === "public") {
      return true;
    }

    // Non-public posts require authentication
    if (!userId) {
      return false;
    }

    // Get user's subscription to the publication
    const { data: subscription } = await supabaseAdmin
      .from("subscriptions")
      .select("*")
      .eq("publication_id", post.publication)
      .eq("user_id", userId)
      .single();

    if (!subscription) {
      return false;
    }

    // Check for free subscriber access
    if (post.visibility === "free_subscribers") {
      return subscription.status === "active";
    }

    // Check for paid subscriber access
    if (post.visibility === "paid_subscribers") {
      if (subscription.subscription_type !== "paid") {
        return false;
      }

      const now = new Date();

      if (subscription.status === "active") {
        // If we have a period end, verify it hasn't lapsed (guards against missed renewal webhooks)
        if (subscription.current_period_end != null) {
          return now < new Date(subscription.current_period_end);
        }
        // No period end set — trust the active status
        return true;
      }

      // Cancelled: retain access until period end
      if (subscription.status === "cancelled" && subscription.current_period_end) {
        return now < new Date(subscription.current_period_end);
      }

      return false;
    }

    return false;
  }

  /**
   * Expire cancelled subscriptions past their period end
   * Run by scheduler hourly
   */
  async expireCancelledSubscriptions(): Promise<number> {
    const now = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .update({ status: "expired" })
      .eq("status", "cancelled")
      .lt("current_period_end", now)
      .select("id");

    if (error) {
      console.error(
        "[SubscriptionService] Error expiring subscriptions:",
        error,
      );
      return 0;
    }

    return data?.length || 0;
  }

  /**
   * Get subscriptions that need renewal reminders (3 days before expiry)
   */
  async getSubscriptionsNeedingReminder(): Promise<Subscription[]> {
    const threeDaysFromNow = new Date();
    threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

    const twoDaysFromNow = new Date();
    twoDaysFromNow.setDate(twoDaysFromNow.getDate() + 2);

    const { data, error } = await supabaseAdmin
      .from("subscriptions")
      .select(
        `
        *,
        user:user_id(email, name),
        publication:publication_id(name)
      `,
      )
      .eq("status", "active")
      .eq("subscription_type", "paid")
      .gte("current_period_end", twoDaysFromNow.toISOString())
      .lte("current_period_end", threeDaysFromNow.toISOString());

    if (error) {
      console.error(
        "[SubscriptionService] Error fetching reminder subscriptions:",
        error,
      );
      return [];
    }

    return data || [];
  }

  /**
   * Clean up pending payments older than 24 hours
   */
  async cleanupPendingPayments(): Promise<number> {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);

    const { data, error } = await supabaseAdmin
      .from("subscription_payments")
      .update({ status: "failed" })
      .eq("status", "pending")
      .lt("created_at", twentyFourHoursAgo.toISOString())
      .select("id");

    if (error) {
      console.error("[SubscriptionService] Error cleaning up payments:", error);
      return 0;
    }

    return data?.length || 0;
  }

  /**
   * Helper to get user email
   */
  private async getUserEmail(
    supabaseClient: SupabaseClient,
    userId: string,
  ): Promise<string> {
    const { data, error } = await supabaseClient
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();

    if (error || !data?.email) {
      throw new Error("User email not found");
    }

    return data.email;
  }

  /**
   * Handle Paystack auto-renewal charge.success for a publication subscription.
   * Called when Paystack fires charge.success with a subscription_code but no
   * custom metadata (the renewal billing is automated — no original metadata).
   *
   * Returns true if the subscription was found and renewed; false to fall through.
   */
  async activateRenewalFromSubscriptionCode(
    paystackSubscriptionCode: string,
    reference: string,
    amountKobo: number,
  ): Promise<boolean> {
    if (!paystackSubscriptionCode || !reference) return false;

    const { data: existing } = await supabaseAdmin
      .from("subscriptions")
      .select("id, user_id, publication_id, plan, status, current_period_end")
      .eq("paystack_subscription_code", paystackSubscriptionCode)
      .maybeSingle();

    if (!existing) return false;

    const now = new Date();
    // Extend from the current period end (or now if it has already lapsed)
    const base =
      existing.current_period_end && new Date(existing.current_period_end) > now
        ? new Date(existing.current_period_end)
        : now;
    const newPeriodEnd = new Date(base);

    if (existing.plan === "monthly") {
      newPeriodEnd.setMonth(newPeriodEnd.getMonth() + 1);
    } else {
      newPeriodEnd.setFullYear(newPeriodEnd.getFullYear() + 1);
    }

    await supabaseAdmin
      .from("subscriptions")
      .update({
        status: "active",
        current_period_end: newPeriodEnd.toISOString(),
        cancelled_at: null,
      })
      .eq("id", existing.id);

    // Record the renewal payment
    await supabaseAdmin.from("subscription_payments").insert({
      subscription_id: existing.id,
      amount: amountKobo,
      currency: "NGN",
      paystack_reference: reference,
      status: "success",
      processed_at: now.toISOString(),
    });

    console.log(
      `[PublicationSubscription] Renewed subscription ${existing.id} until ${newPeriodEnd.toISOString()}`,
    );
    return true;
  }

  /**
   * Handle Paystack subscription.create webhook — stores the subscription_code
   * so future renewals can be matched back to our subscription record.
   */
  async handleSubscriptionCreated(
    paystackSubscriptionCode: string,
    customerEmail: string,
  ): Promise<void> {
    if (!paystackSubscriptionCode || !customerEmail) return;

    // Find the most recent active/paid subscription for this email that has no code yet
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", customerEmail)
      .maybeSingle();

    if (!user) return;

    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("user_id", user.id)
      .eq("subscription_type", "paid")
      .eq("status", "active")
      .is("paystack_subscription_code", null)
      .order("subscribed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!sub) return;

    await supabaseAdmin
      .from("subscriptions")
      .update({ paystack_subscription_code: paystackSubscriptionCode })
      .eq("id", sub.id);

    console.log(
      `[PublicationSubscription] Stored subscription code ${paystackSubscriptionCode} on subscription ${sub.id}`,
    );
  }

  /**
   * Notify subscriber that their payment failed and they should update their card.
   */
  async notifyPaymentFailed(paystackCode: string): Promise<void> {
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("id, user_id, publication_id, plan, current_period_end")
      .eq("paystack_subscription_code", paystackCode)
      .maybeSingle();

    if (!sub) return;

    const [{ data: user }, { data: publication }] = await Promise.all([
      supabaseAdmin.from("users").select("email, name").eq("id", sub.user_id).single(),
      supabaseAdmin.from("publications").select("name").eq("id", sub.publication_id).single(),
    ]);

    if (!user?.email || !publication) return;

    const accessUntil = sub.current_period_end
      ? new Date(sub.current_period_end).toLocaleDateString()
      : "soon";

    const emailBody = wrapInBaseEmail({
      title: "Payment Failed",
      businessName: "Hilaq",
      content: `
        <h1>Your payment failed</h1>
        <p>Hi ${user.name || "there"},</p>
        <p>We were unable to renew your <strong>${sub.plan === "monthly" ? "monthly" : "yearly"}</strong> subscription to <strong>${publication.name}</strong>.</p>
        <p>Your access will continue until <strong>${accessUntil}</strong>. After that, you'll lose access to paid content.</p>
        <p>To keep your subscription active, please update your payment method or re-subscribe before your access expires.</p>
      `,
    });

    await emailService.send({
      to: user.email,
      subject: `Payment failed for ${publication.name}`,
      body: emailBody,
      type: "platform",
    });

    console.log(`[PublicationSubscription] Payment failed notification sent to ${user.email}`);
  }

  /**
   * Handle 'subscription.disable' webhook event
   * Mark subscription as cancelled
   */
  async handleSubscriptionDisabled(paystackCode: string): Promise<void> {
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("id, status")
      .eq("paystack_subscription_code", paystackCode)
      .single();

    if (!sub) {
      console.warn(
        `[SubscriptionService] Subscription not found for code: ${paystackCode}`,
      );
      return;
    }

    if (sub.status === "cancelled" || sub.status === "expired") return;

    await supabaseAdmin
      .from("subscriptions")
      .update({
        status: "cancelled",
        cancelled_at: new Date().toISOString(),
      })
      .eq("id", sub.id);

    console.log(
      `[SubscriptionService] Marked subscription ${sub.id} as cancelled (webhook)`,
    );
  }

  /**
   * Handle 'invoice.payment_failed' webhook event
   * Mark subscription as at_risk or notify user (placeholder)
   */
  async handlePaymentFailed(paystackCode: string): Promise<void> {
    const { data: sub } = await supabaseAdmin
      .from("subscriptions")
      .select("id, user_id") // Could fetch user email for notification
      .eq("paystack_subscription_code", paystackCode)
      .single();

    if (!sub) {
      console.warn(
        `[SubscriptionService] Subscription not found for code: ${paystackCode}`,
      );
      return;
    }

    // TODO: Implement user notification logic here or mark as 'past_due' if schema allows
    console.log(
      `[SubscriptionService] Payment failed for subscription ${sub.id}. Action required.`,
    );
  }

  /**
   * Send new subscriber notification to publication owner
   */
  private async sendNewSubscriberNotification(
    publicationId: string,
    subscriberId: string,
    planName: string,
  ): Promise<void> {
    try {
      // 1. Get publication details (owner)
      const { data: publication } = await supabaseAdmin
        .from("publications")
        .select("name, user_id")
        .eq("id", publicationId)
        .single();

      if (!publication) return;

      // 2. Check owner preferences
      const shouldSend = await NotificationUtil.shouldSendNotification(
        publication.user_id,
        "email_new_subscriber",
      );

      if (!shouldSend) {
        console.log(
          `Skipping new subscriber notification for owner ${publication.user_id} based on preferences`,
        );
        return;
      }

      // 3. Get subscriber details
      const { data: subscriber } = await supabaseAdmin
        .from("users")
        .select("name, email")
        .eq("id", subscriberId)
        .single();

      if (!subscriber) return;

      // 4. Get owner email
      const { data: owner } = await supabaseAdmin
        .from("users")
        .select("email")
        .eq("id", publication.user_id)
        .single();

      if (!owner?.email) return;

      // 5. Send email
      const emailBody = wrapInBaseEmail({
        title: "New Subscriber!",
        businessName: "Hilaq Publications",
        content: `
          <h1>New Subscriber! 🎉</h1>
          <p>Great news! You have a new subscriber for <strong>${publication.name}</strong>.</p>
          
          <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
            <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Subscriber Info</h3>
            <p style="margin: 8px 0;"><strong>Name:</strong> ${subscriber.name}</p>
            <p style="margin: 8px 0;"><strong>Plan:</strong> ${planName}</p>
            <p style="margin: 8px 0;"><strong>Date:</strong> ${new Date().toLocaleDateString()}</p>
          </div>
          
          <p>Keep up the great work!</p>
        `,
      });

      await emailService.send({
        to: owner.email,
        subject: `🎉 New Subscriber on ${publication.name}`,
        body: emailBody,
        type: "platform",
      });

      console.log(`New subscriber notification sent to ${owner.email}`);
    } catch (error) {
      console.error(
        "[SubscriptionService] Failed to send new subscriber notification:",
        error,
      );
    }
  }
}

export const publicationSubscriptionService =
  new PublicationSubscriptionService();
