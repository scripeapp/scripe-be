import { SupabaseClient } from "@supabase/supabase-js";

export type KYCStatus = "not_submitted" | "pending" | "approved" | "rejected" | "expired";

export class KYCService {
  /**
   * Submit KYC documents for a business
   */
  async submitKYC(
    supabase: SupabaseClient,
    businessId: string,
    data: {
      document_type: "cac" | "nin" | "bvn" | "utility_bill" | "id_card" | "passport";
      document_number?: string;
      document_url?: string;
      metadata?: Record<string, any>;
    },
  ) {
    // Check for existing pending/approved
    const { data: existing } = await supabase
      .from("kyc_verifications")
      .select("id, status")
      .eq("business_id", businessId)
      .eq("document_type", data.document_type)
      .in("status", ["pending", "approved"])
      .single();

    if (existing) {
      throw new Error(
        `A ${data.document_type} verification is already ${existing.status}.`,
      );
    }

    const { data: kyc, error } = await supabase
      .from("kyc_verifications")
      .insert({
        business_id: businessId,
        document_type: data.document_type,
        document_number: data.document_number,
        document_url: data.document_url,
        metadata: data.metadata,
        status: "pending",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return kyc;
  }

  /**
   * List KYC submissions with filters (admin view)
   */
  async listKYC(
    supabase: SupabaseClient,
    params: {
      status?: string;
      document_type?: string;
      business_id?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 25;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("kyc_verifications")
      .select(
        `*, businesses:business_id (name, email, subscription_plan)`,
        { count: "exact" },
      )
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.status && params.status !== "all") {
      query = query.eq("status", params.status);
    }
    if (params.document_type) {
      query = query.eq("document_type", params.document_type);
    }
    if (params.business_id) {
      query = query.eq("business_id", params.business_id);
    }

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Get KYC status for a specific business
   */
  async getBusinessKYC(supabase: SupabaseClient, businessId: string) {
    const { data, error } = await supabase
      .from("kyc_verifications")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (error) throw new Error(error.message);
    return data || [];
  }

  /**
   * Admin reviews a KYC submission
   */
  async reviewKYC(
    supabase: SupabaseClient,
    id: string,
    action: "approve" | "reject",
    reviewedBy: string,
    rejectionReason?: string,
  ) {
    const now = new Date().toISOString();
    const status: KYCStatus = action === "approve" ? "approved" : "rejected";

    const updateData: Record<string, any> = {
      status,
      reviewed_by: reviewedBy,
      reviewed_at: now,
    };

    if (action === "approve") {
      // Set expiry to 1 year from now
      const expiry = new Date();
      expiry.setFullYear(expiry.getFullYear() + 1);
      updateData.expires_at = expiry.toISOString();
    } else {
      updateData.rejection_reason = rejectionReason;
    }

    const { data, error } = await supabase
      .from("kyc_verifications")
      .update(updateData)
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Update business is_verified flag if approved
    if (action === "approve" && data?.business_id) {
      await supabase
        .from("businesses")
        .update({ is_verified: true })
        .eq("id", data.business_id);
    }

    return data;
  }

  /**
   * KYC summary stats
   */
  async getKYCStats(supabase: SupabaseClient) {
    const statuses = ["pending", "approved", "rejected"] as const;
    const results = await Promise.all(
      statuses.map((s) =>
        supabase
          .from("kyc_verifications")
          .select("id", { count: "exact" })
          .eq("status", s),
      ),
    );

    return {
      pending: results[0].count || 0,
      approved: results[1].count || 0,
      rejected: results[2].count || 0,
    };
  }
}

export const kycService = new KYCService();
