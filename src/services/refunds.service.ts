import { SupabaseClient } from "@supabase/supabase-js";

export type RefundStatus = "pending" | "approved" | "rejected" | "processed" | "failed";
export type DisputeStatus = "open" | "investigating" | "resolved" | "closed";

export class RefundsService {
  /**
   * Create a refund request (can be admin-initiated or system-triggered)
   */
  async createRefund(
    supabase: SupabaseClient,
    data: {
      business_id: string;
      transaction_id?: string;
      amount_ngn: number;
      reason: string;
      notes?: string;
      created_by?: string;
    },
  ) {
    const { data: refund, error } = await supabase
      .from("refund_requests")
      .insert({
        business_id: data.business_id,
        transaction_id: data.transaction_id,
        amount_ngn: data.amount_ngn,
        reason: data.reason,
        notes: data.notes,
        status: "pending",
        created_by: data.created_by,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return refund;
  }

  /**
   * List refund requests with filters
   */
  async listRefunds(
    supabase: SupabaseClient,
    params: {
      status?: string;
      business_id?: string;
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
      .from("refund_requests")
      .select(
        `
        *,
        businesses:business_id (name, email)
      `,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all") {
      query = query.eq("status", params.status);
    }
    if (params.business_id) {
      query = query.eq("business_id", params.business_id);
    }
    if (params.from) {
      query = query.gte("created_at", params.from);
    }
    if (params.to) {
      query = query.lte("created_at", params.to);
    }

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);

    return {
      data: data || [],
      total: count || 0,
      page,
      limit,
    };
  }

  /**
   * Update refund status (approve/reject/process)
   */
  async reviewRefund(
    supabase: SupabaseClient,
    id: string,
    action: "approve" | "reject",
    reviewedBy: string,
    adminNotes?: string,
  ) {
    const status: RefundStatus = action === "approve" ? "approved" : "rejected";

    const { data, error } = await supabase
      .from("refund_requests")
      .update({
        status,
        reviewed_by: reviewedBy,
        admin_notes: adminNotes,
        reviewed_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Create a dispute
   */
  async createDispute(
    supabase: SupabaseClient,
    data: {
      business_id: string;
      transaction_id?: string;
      refund_id?: string;
      subject: string;
      description: string;
      raised_by?: string;
    },
  ) {
    const { data: dispute, error } = await supabase
      .from("disputes")
      .insert({
        ...data,
        status: "open",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return dispute;
  }

  /**
   * List disputes
   */
  async listDisputes(
    supabase: SupabaseClient,
    params: {
      status?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 25;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("disputes")
      .select(
        `*, businesses:business_id (name, email)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all") {
      query = query.eq("status", params.status);
    }

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);

    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Resolve a dispute
   */
  async resolveDispute(
    supabase: SupabaseClient,
    id: string,
    resolution: string,
    resolvedBy: string,
  ) {
    const { data, error } = await supabase
      .from("disputes")
      .update({
        status: "resolved",
        resolution,
        resolved_by: resolvedBy,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Get summary stats
   */
  async getRefundStats(supabase: SupabaseClient) {
    const { data, error } = await supabase.rpc("get_refund_stats").single();

    // Fallback to manual aggregation if RPC doesn't exist
    if (error) {
      const [pending, approved, rejected, disputes] = await Promise.all([
        supabase.from("refund_requests").select("id", { count: "exact" }).eq("status", "pending"),
        supabase.from("refund_requests").select("id", { count: "exact" }).eq("status", "approved"),
        supabase.from("refund_requests").select("id", { count: "exact" }).eq("status", "rejected"),
        supabase.from("disputes").select("id", { count: "exact" }).eq("status", "open"),
      ]);

      return {
        pending: pending.count || 0,
        approved: approved.count || 0,
        rejected: rejected.count || 0,
        open_disputes: disputes.count || 0,
      };
    }

    return data;
  }
}

export const refundsService = new RefundsService();
