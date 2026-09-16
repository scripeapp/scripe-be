/**
 * Admin Alerts Service
 * Generates and stores real-time alerts for important platform events
 *
 * Alert types:
 * - large_transaction: order/payment above threshold
 * - new_enterprise_signup: pro plan signup
 * - high_churn: churn rate above threshold
 * - dunning_cancelled: subscription cancelled via dunning
 * - failed_payments_spike: multiple failures in short window
 * - new_admin_action: sensitive admin actions
 * - plan_limit_spike: sudden spike in upgrade signals
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertType =
  | "large_transaction"
  | "new_enterprise_signup"
  | "high_churn"
  | "dunning_cancelled"
  | "failed_payments_spike"
  | "new_admin_action"
  | "plan_limit_spike"
  | "new_pro_signup"
  | "payout_request"
  | "system_error";

export interface AdminAlert {
  id: string;
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  metadata: Record<string, any>;
  is_read: boolean;
  read_at: string | null;
  created_at: string;
}

// Alert thresholds
const THRESHOLDS = {
  large_transaction_ngn: 100_000,   // ₦100,000+
  failed_payments_window_hours: 1,
  failed_payments_spike_count: 5,
};

export class AdminAlertsService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Create a new alert
   */
  async createAlert(
    supabase: SupabaseClient | undefined,
    params: {
      type: AlertType;
      severity: AlertSeverity;
      title: string;
      message: string;
      metadata?: Record<string, any>;
    },
  ): Promise<AdminAlert | null> {
    const client = this.getClient(supabase);

    try {
      const { data, error } = await client
        .from("admin_alerts")
        .insert({
          type: params.type,
          severity: params.severity,
          title: params.title,
          message: params.message,
          metadata: params.metadata || {},
          is_read: false,
        })
        .select()
        .single();

      if (error) throw error;
      return data as AdminAlert;
    } catch (err) {
      console.error("[AdminAlerts] createAlert error:", err);
      return null;
    }
  }

  /**
   * Trigger alert for a large transaction
   */
  async checkLargeTransaction(
    supabase: SupabaseClient | undefined,
    amount: number,
    businessName: string,
    source: string,
    reference: string,
  ): Promise<void> {
    if (amount < THRESHOLDS.large_transaction_ngn) return;

    await this.createAlert(supabase, {
      type: "large_transaction",
      severity: amount >= 500_000 ? "critical" : "warning",
      title: `Large transaction: ₦${amount.toLocaleString()}`,
      message: `${businessName} processed a ₦${amount.toLocaleString()} ${source} payment (ref: ${reference})`,
      metadata: { amount, businessName, source, reference },
    });
  }

  /**
   * Trigger alert for a new Pro/Enterprise signup
   */
  async alertNewProSignup(
    supabase: SupabaseClient | undefined,
    businessName: string,
    plan: string,
    businessId: string,
  ): Promise<void> {
    if (plan !== "pro") return;

    await this.createAlert(supabase, {
      type: "new_pro_signup",
      severity: "info",
      title: `New Pro signup: ${businessName}`,
      message: `${businessName} just upgraded to the Pro plan`,
      metadata: { businessName, plan, businessId },
    });
  }

  /**
   * Trigger alert when dunning cancels a subscription
   */
  async alertDunningCancelled(
    supabase: SupabaseClient | undefined,
    businessId: string,
    plan: string,
    attempts: number,
  ): Promise<void> {
    await this.createAlert(supabase, {
      type: "dunning_cancelled",
      severity: "warning",
      title: `Subscription cancelled via dunning`,
      message: `Business ${businessId} on ${plan} plan was downgraded to starter after ${attempts} failed payment attempts`,
      metadata: { businessId, plan, attempts },
    });
  }

  /**
   * Get all alerts with filters
   */
  async getAlerts(
    supabase: SupabaseClient | undefined,
    options: {
      page?: number;
      limit?: number;
      unread_only?: boolean;
      severity?: AlertSeverity;
      type?: AlertType;
    } = {},
  ): Promise<{ data: AdminAlert[]; total: number; unread: number }> {
    const client = this.getClient(supabase);
    const { page = 1, limit = 30, unread_only, severity, type } = options;
    const offset = (page - 1) * limit;

    let query = client
      .from("admin_alerts")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (unread_only) query = query.eq("is_read", false);
    if (severity) query = query.eq("severity", severity);
    if (type) query = query.eq("type", type);

    const { data, count, error } = await query;
    if (error) throw error;

    // Count unread separately
    const { count: unreadCount } = await client
      .from("admin_alerts")
      .select("*", { count: "exact", head: true })
      .eq("is_read", false);

    return {
      data: (data || []) as AdminAlert[],
      total: count || 0,
      unread: unreadCount || 0,
    };
  }

  /**
   * Mark alerts as read
   */
  async markAsRead(
    supabase: SupabaseClient | undefined,
    alertIds: string[],
  ): Promise<void> {
    const client = this.getClient(supabase);

    await client
      .from("admin_alerts")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .in("id", alertIds);
  }

  /**
   * Mark all alerts as read
   */
  async markAllRead(supabase?: SupabaseClient): Promise<void> {
    const client = this.getClient(supabase);

    await client
      .from("admin_alerts")
      .update({ is_read: true, read_at: new Date().toISOString() })
      .eq("is_read", false);
  }

  /**
   * Get unread count (for notification bell)
   */
  async getUnreadCount(supabase?: SupabaseClient): Promise<number> {
    const client = this.getClient(supabase);

    const { count } = await client
      .from("admin_alerts")
      .select("*", { count: "exact", head: true })
      .eq("is_read", false);

    return count || 0;
  }

  /**
   * Delete old alerts (cleanup)
   */
  async deleteOldAlerts(
    supabase: SupabaseClient | undefined,
    olderThanDays: number = 90,
  ): Promise<number> {
    const client = this.getClient(supabase);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - olderThanDays);

    const { count } = await client
      .from("admin_alerts")
      .delete({ count: "exact" })
      .lt("created_at", cutoff.toISOString())
      .eq("is_read", true);

    return count || 0;
  }
}

export const adminAlertsService = new AdminAlertsService();
