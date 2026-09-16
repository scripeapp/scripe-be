/**
 * Webhook Logs Service
 * Records all incoming/outgoing webhook events for visibility and debugging
 */

import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";

export type WebhookDirection = "inbound" | "outbound";
export type WebhookStatus = "received" | "processed" | "failed" | "ignored";

export interface WebhookLog {
  id: string;
  direction: WebhookDirection;
  source: string;           // e.g. "paystack", "internal"
  event_type: string;       // e.g. "charge.success"
  reference: string | null;
  business_id: string | null;
  status: WebhookStatus;
  payload: Record<string, any>;
  error_message: string | null;
  processing_time_ms: number | null;
  created_at: string;
}

export class WebhookLogsService {
  private getClient(supabase?: SupabaseClient): SupabaseClient {
    return supabaseAdmin || supabase!;
  }

  /**
   * Log an incoming webhook event
   */
  async log(
    params: {
      direction?: WebhookDirection;
      source: string;
      eventType: string;
      reference?: string;
      businessId?: string;
      status: WebhookStatus;
      payload: Record<string, any>;
      errorMessage?: string;
      processingTimeMs?: number;
    },
    supabase?: SupabaseClient,
  ): Promise<void> {
    const client = this.getClient(supabase);

    try {
      await client.from("webhook_logs").insert({
        direction: params.direction || "inbound",
        source: params.source,
        event_type: params.eventType,
        reference: params.reference || null,
        business_id: params.businessId || null,
        status: params.status,
        payload: params.payload,
        error_message: params.errorMessage || null,
        processing_time_ms: params.processingTimeMs || null,
      });
    } catch (err) {
      // Never throw — logging should never break the main flow
      console.error("[WebhookLogs] Failed to log:", err);
    }
  }

  /**
   * Get webhook logs with filters
   */
  async getLogs(
    supabase: SupabaseClient | undefined,
    options: {
      page?: number;
      limit?: number;
      source?: string;
      eventType?: string;
      status?: WebhookStatus;
      businessId?: string;
      from?: string;
      to?: string;
    } = {},
  ): Promise<{ data: WebhookLog[]; total: number }> {
    const client = this.getClient(supabase);
    const { page = 1, limit = 50, source, eventType, status, businessId, from, to } = options;
    const offset = (page - 1) * limit;

    let query = client
      .from("webhook_logs")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (source) query = query.eq("source", source);
    if (eventType) query = query.eq("event_type", eventType);
    if (status) query = query.eq("status", status);
    if (businessId) query = query.eq("business_id", businessId);
    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, count, error } = await query;
    if (error) throw error;

    return { data: (data || []) as WebhookLog[], total: count || 0 };
  }

  /**
   * Get webhook stats summary
   */
  async getStats(supabase?: SupabaseClient): Promise<{
    total: number;
    processed: number;
    failed: number;
    failureRate: number;
    recentErrors: WebhookLog[];
  }> {
    const client = this.getClient(supabase);
    const since = new Date();
    since.setDate(since.getDate() - 7);

    const { data: recent } = await client
      .from("webhook_logs")
      .select("status, event_type, error_message, created_at, source, reference")
      .gte("created_at", since.toISOString())
      .order("created_at", { ascending: false })
      .limit(1000);

    const logs = recent || [];
    const total = logs.length;
    const processed = logs.filter((l) => l.status === "processed").length;
    const failed = logs.filter((l) => l.status === "failed").length;
    const failureRate = total > 0 ? parseFloat(((failed / total) * 100).toFixed(2)) : 0;
    const recentErrors = logs.filter((l) => l.status === "failed").slice(0, 10) as WebhookLog[];

    return { total, processed, failed, failureRate, recentErrors };
  }
}

export const webhookLogsService = new WebhookLogsService();
