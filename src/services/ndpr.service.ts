import { SupabaseClient } from "@supabase/supabase-js";

export type NDPRRequestType = "access" | "deletion" | "portability" | "rectification" | "objection";
export type NDPRRequestStatus = "pending" | "processing" | "completed" | "rejected";

export class NDPRService {
  /**
   * Create a NDPR data request
   */
  async createRequest(
    supabase: SupabaseClient,
    data: {
      user_id?: string;
      business_id?: string;
      request_type: NDPRRequestType;
      requester_email: string;
      description?: string;
    },
  ) {
    const { data: request, error } = await supabase
      .from("ndpr_requests")
      .insert({
        ...data,
        status: "pending",
        due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(), // 30 days
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return request;
  }

  /**
   * List NDPR requests
   */
  async listRequests(
    supabase: SupabaseClient,
    params: {
      status?: string;
      request_type?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 25;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("ndpr_requests")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all")
      query = query.eq("status", params.status);
    if (params.request_type && params.request_type !== "all")
      query = query.eq("request_type", params.request_type);

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Process an access/portability request — collect all user data
   */
  async generateDataExport(
    supabase: SupabaseClient,
    userId: string,
  ): Promise<Record<string, any>> {
    const [profile, businesses, bookings, orders] = await Promise.all([
      supabase.from("users").select("*").eq("id", userId).single(),
      supabase.from("businesses").select("*").eq("owner_id", userId),
      supabase.from("bookings").select("*").eq("user_id", userId).limit(500),
      supabase.from("orders").select("*").eq("user_id", userId).limit(500),
    ]);

    return {
      profile: profile.data,
      businesses: businesses.data || [],
      bookings: bookings.data || [],
      orders: orders.data || [],
      export_generated_at: new Date().toISOString(),
    };
  }

  /**
   * Update NDPR request status
   */
  async updateRequest(
    supabase: SupabaseClient,
    id: string,
    status: NDPRRequestStatus,
    adminId: string,
    notes?: string,
    export_url?: string,
  ) {
    const { data, error } = await supabase
      .from("ndpr_requests")
      .update({
        status,
        processed_by: adminId,
        admin_notes: notes,
        export_url,
        processed_at: status !== "pending" ? new Date().toISOString() : null,
      })
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  /**
   * Delete user data (for deletion requests)
   * Anonymizes PII rather than hard-deleting to preserve audit trails
   */
  async anonymizeUser(
    supabase: SupabaseClient,
    userId: string,
    requestId: string,
  ) {
    const anonymizedEmail = `deleted_${userId}@removed.hilaq.ng`;
    const anonymizedName = "Deleted User";

    const { error } = await supabase
      .from("users")
      .update({
        email: anonymizedEmail,
        full_name: anonymizedName,
        phone: null,
        avatar_url: null,
        is_deleted: true,
        deleted_at: new Date().toISOString(),
        ndpr_deletion_request_id: requestId,
      })
      .eq("id", userId);

    if (error) throw new Error(error.message);

    return { anonymized: true, email: anonymizedEmail };
  }

  /**
   * Get NDPR stats
   */
  async getStats(supabase: SupabaseClient) {
    const [pending, overdue, completed] = await Promise.all([
      supabase.from("ndpr_requests").select("id", { count: "exact" }).eq("status", "pending"),
      supabase
        .from("ndpr_requests")
        .select("id", { count: "exact" })
        .eq("status", "pending")
        .lt("due_date", new Date().toISOString()),
      supabase.from("ndpr_requests").select("id", { count: "exact" }).eq("status", "completed"),
    ]);

    return {
      pending: pending.count || 0,
      overdue: overdue.count || 0,
      completed: completed.count || 0,
    };
  }
}

export const ndprService = new NDPRService();
