import { SupabaseClient } from "@supabase/supabase-js";

export type FraudSeverity = "low" | "medium" | "high" | "critical";
export type FraudStatus = "open" | "investigating" | "confirmed" | "cleared";

export class FraudDetectionService {
  /**
   * Record a fraud signal (can be called from various points in the system)
   */
  async recordSignal(
    supabase: SupabaseClient,
    signal: {
      entity_type: "user" | "business" | "transaction";
      entity_id: string;
      signal_type: string;
      description: string;
      severity: FraudSeverity;
      metadata?: Record<string, any>;
    },
  ) {
    try {
      const { data, error } = await supabase
        .from("fraud_signals")
        .insert({
          entity_type: signal.entity_type,
          entity_id: signal.entity_id,
          signal_type: signal.signal_type,
          description: signal.description,
          severity: signal.severity,
          metadata: signal.metadata,
          status: "open",
        })
        .select()
        .single();

      if (error) throw new Error(error.message);
      return data;
    } catch (e) {
      // Non-blocking — log but don't throw
      console.error("[fraud-detection] Failed to record signal:", e);
    }
  }

  /**
   * List fraud signals with filters
   */
  async listSignals(
    supabase: SupabaseClient,
    params: {
      status?: string;
      severity?: string;
      entity_type?: string;
      page?: number;
      limit?: number;
      from?: string;
      to?: string;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 25;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("fraud_signals")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all")
      query = query.eq("status", params.status);
    if (params.severity && params.severity !== "all")
      query = query.eq("severity", params.severity);
    if (params.entity_type && params.entity_type !== "all")
      query = query.eq("entity_type", params.entity_type);
    if (params.from) query = query.gte("created_at", params.from);
    if (params.to) query = query.lte("created_at", params.to);

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Update fraud signal status
   */
  async reviewSignal(
    supabase: SupabaseClient,
    id: string,
    status: FraudStatus,
    reviewedBy: string,
    notes?: string,
  ) {
    const { data, error } = await supabase
      .from("fraud_signals")
      .update({
        status,
        reviewed_by: reviewedBy,
        review_notes: notes,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Get fraud summary statistics
   */
  async getFraudStats(supabase: SupabaseClient) {
    const [open, investigating, confirmed, critical, high] = await Promise.all([
      supabase.from("fraud_signals").select("id", { count: "exact" }).eq("status", "open"),
      supabase.from("fraud_signals").select("id", { count: "exact" }).eq("status", "investigating"),
      supabase.from("fraud_signals").select("id", { count: "exact" }).eq("status", "confirmed"),
      supabase.from("fraud_signals").select("id", { count: "exact" }).eq("severity", "critical").eq("status", "open"),
      supabase.from("fraud_signals").select("id", { count: "exact" }).eq("severity", "high").eq("status", "open"),
    ]);

    return {
      open: open.count || 0,
      investigating: investigating.count || 0,
      confirmed: confirmed.count || 0,
      critical_open: critical.count || 0,
      high_open: high.count || 0,
    };
  }

  /**
   * Run automated fraud checks on a transaction or event
   * Returns list of triggered signals
   */
  async runChecks(
    supabase: SupabaseClient,
    context: {
      entity_type: "user" | "business" | "transaction";
      entity_id: string;
      amount?: number;
      ip?: string;
      metadata?: Record<string, any>;
    },
  ) {
    const signals = [];

    // Rule 1: Large transaction threshold (>₦500,000)
    if (context.amount && context.amount > 500000) {
      signals.push({
        signal_type: "large_transaction",
        description: `Transaction of ₦${context.amount.toLocaleString()} exceeds threshold`,
        severity: "high" as FraudSeverity,
      });
    }

    // Rule 2: Extremely large transaction (>₦2,000,000)
    if (context.amount && context.amount > 2000000) {
      signals.push({
        signal_type: "very_large_transaction",
        description: `Transaction of ₦${context.amount.toLocaleString()} requires manual review`,
        severity: "critical" as FraudSeverity,
      });
    }

    // Record all triggered signals
    await Promise.all(
      signals.map((s) =>
        this.recordSignal(supabase, {
          entity_type: context.entity_type,
          entity_id: context.entity_id,
          signal_type: s.signal_type,
          description: s.description,
          severity: s.severity,
          metadata: context.metadata,
        }),
      ),
    );

    return signals;
  }
}

export const fraudDetectionService = new FraudDetectionService();
