/**
 * Subscription Dunning Service
 * Handles failed payment retries and grace period logic for business subscriptions
 *
 * Flow:
 *  Day 0  — Payment fails → create dunning record, mark as past_due, send email
 *  Day 3  — Retry reminder email
 *  Day 7  — Second retry + warning email
 *  Day 14 — Final warning email
 *  Day 15 — Cancel subscription, downgrade to starter
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { inspect } from "util";
import supabaseAdmin from "../config/supabaseAdmin";

export type DunningStatus = "active" | "resolved" | "cancelled";

export interface DunningRecord {
  id: string;
  business_id: string;
  subscription_plan: string;
  failure_reason: string | null;
  attempt_count: number;
  first_failed_at: string;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  resolved_at: string | null;
  cancelled_at: string | null;
  status: DunningStatus;
  created_at: string;
}

export interface DunningCase extends DunningRecord {
  business_name?: string;
  business_email?: string;
}

export class DunningService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  private daysFromNow(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  private daysFromDate(date: string, days: number): string {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  /**
   * Start dunning for a business — called on charge.failed or invoice.payment_failed
   */
  async startDunning(
    supabase: SupabaseClient | undefined,
    businessId: string,
    plan: string,
    failureReason?: string,
  ): Promise<DunningRecord | null> {
    const client = this.getClient(supabase);

    try {
      // Check if already in dunning to avoid duplicates
      const { data: existing } = await client
        .from("subscription_dunning")
        .select("id")
        .eq("business_id", businessId)
        .eq("status", "active")
        .maybeSingle();

      if (existing) {
        console.log(
          `[Dunning] Business ${businessId} already in dunning, skipping.`,
        );
        return null;
      }

      // Create dunning record
      const { data: record, error } = await client
        .from("subscription_dunning")
        .insert({
          business_id: businessId,
          subscription_plan: plan,
          failure_reason: failureReason || "Payment failed",
          attempt_count: 0,
          first_failed_at: new Date().toISOString(),
          next_retry_at: this.daysFromNow(3),
          status: "active",
        })
        .select()
        .single();

      if (error) throw error;

      // Mark business as past_due
      await client
        .from("businesses")
        .update({ subscription_status: "past_due" })
        .eq("id", businessId);

      console.log(
        `[Dunning] Started dunning for business ${businessId} on plan ${plan}`,
      );
      return record as DunningRecord;
    } catch (err) {
      console.error(
        "[Dunning] startDunning error:",
        inspect(err, { depth: null }),
      );
      return null;
    }
  }

  /**
   * Record successful payment — resolves active dunning
   */
  async recordPaymentSuccess(
    supabase: SupabaseClient | undefined,
    businessId: string,
  ): Promise<DunningRecord | null> {
    const client = this.getClient(supabase);

    try {
      const { data: record, error } = await client
        .from("subscription_dunning")
        .update({
          status: "resolved",
          resolved_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("business_id", businessId)
        .eq("status", "active")
        .select()
        .maybeSingle();

      if (error) throw error;

      if (record) {
        // Restore subscription to active
        await client
          .from("businesses")
          .update({ subscription_status: "active" })
          .eq("id", businessId);

        console.log(
          `[Dunning] Resolved dunning for business ${businessId}`,
        );
      }

      return record as DunningRecord | null;
    } catch (err) {
      // inspect at full depth: PostgrestError props and Error stacks must all
      // survive logging, otherwise failures surface as an opaque `{}`.
      console.error(
        "[Dunning] recordPaymentSuccess error:",
        inspect(err, { depth: null }),
      );
      return null;
    }
  }

  /**
   * Process all due retries — intended to be called by a scheduled job
   * Returns: { processed, cancelled }
   */
  async processRetries(
    supabase?: SupabaseClient,
  ): Promise<{ processed: number; cancelled: number }> {
    const client = this.getClient(supabase);
    let processed = 0;
    let cancelled = 0;

    try {
      const now = new Date().toISOString();

      const { data: dueCases } = await client
        .from("subscription_dunning")
        .select("*")
        .eq("status", "active")
        .lte("next_retry_at", now);

      for (const dunning of dueCases || []) {
        const newAttemptCount = dunning.attempt_count + 1;

        if (newAttemptCount >= 4) {
          // Day 15+ — Cancel and downgrade
          await client
            .from("subscription_dunning")
            .update({
              status: "cancelled",
              cancelled_at: now,
              attempt_count: newAttemptCount,
              last_attempt_at: now,
              next_retry_at: null,
              updated_at: now,
            })
            .eq("id", dunning.id);

          await client
            .from("businesses")
            .update({
              subscription_plan: "starter",
              subscription_status: "cancelled",
            })
            .eq("id", dunning.business_id);

          console.log(
            `[Dunning] Cancelled subscription for business ${dunning.business_id} after ${newAttemptCount} attempts`,
          );
          cancelled++;
        } else {
          // Calculate next retry based on attempt count
          const nextRetryDays =
            newAttemptCount === 1
              ? 7
              : newAttemptCount === 2
                ? 14
                : 15;

          const nextRetryAt = this.daysFromDate(
            dunning.first_failed_at,
            nextRetryDays,
          );

          await client
            .from("subscription_dunning")
            .update({
              attempt_count: newAttemptCount,
              last_attempt_at: now,
              next_retry_at: nextRetryAt,
              updated_at: now,
            })
            .eq("id", dunning.id);

          console.log(
            `[Dunning] Processed attempt ${newAttemptCount} for business ${dunning.business_id}, next retry: ${nextRetryAt}`,
          );
        }

        processed++;
      }
    } catch (err) {
      console.error("[Dunning] processRetries error:", err);
    }

    return { processed, cancelled };
  }

  /**
   * Get current dunning status for a business
   */
  async getDunningStatus(
    supabase: SupabaseClient | undefined,
    businessId: string,
  ): Promise<DunningRecord | null> {
    const client = this.getClient(supabase);

    const { data } = await client
      .from("subscription_dunning")
      .select("*")
      .eq("business_id", businessId)
      .eq("status", "active")
      .maybeSingle();

    return (data as DunningRecord) || null;
  }

  /**
   * List all active dunning cases for the admin dashboard
   */
  async getActiveDunningCases(
    supabase: SupabaseClient | undefined,
    page: number = 1,
    limit: number = 20,
  ): Promise<{ data: DunningCase[]; total: number }> {
    const client = this.getClient(supabase);
    const offset = (page - 1) * limit;

    const { data, count, error } = await client
      .from("subscription_dunning")
      .select(
        `
        *,
        businesses!inner(name, email)
      `,
        { count: "exact" },
      )
      .eq("status", "active")
      .order("first_failed_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    const cases: DunningCase[] = (data || []).map((d: any) => ({
      ...d,
      business_name: d.businesses?.name,
      business_email: d.businesses?.email,
    }));

    return { data: cases, total: count || 0 };
  }

  /**
   * Get dunning history (all statuses) for admin overview
   */
  async getDunningHistory(
    supabase: SupabaseClient | undefined,
    page: number = 1,
    limit: number = 20,
    status?: DunningStatus,
  ): Promise<{ data: DunningCase[]; total: number }> {
    const client = this.getClient(supabase);
    const offset = (page - 1) * limit;

    let query = client
      .from("subscription_dunning")
      .select(
        `
        *,
        businesses(name, email)
      `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) query = query.eq("status", status);

    const { data, count, error } = await query;
    if (error) throw error;

    const cases: DunningCase[] = (data || []).map((d: any) => ({
      ...d,
      business_name: d.businesses?.name,
      business_email: d.businesses?.email,
    }));

    return { data: cases, total: count || 0 };
  }
}

export const dunningService = new DunningService();
