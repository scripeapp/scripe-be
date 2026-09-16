import { SupabaseClient } from "@supabase/supabase-js";

export type NPSCategory = "promoter" | "passive" | "detractor";

function categorize(score: number): NPSCategory {
  if (score >= 9) return "promoter";
  if (score >= 7) return "passive";
  return "detractor";
}

export class NPSService {
  /**
   * Record an NPS response
   */
  async recordResponse(
    supabase: SupabaseClient,
    data: {
      user_id?: string;
      business_id?: string;
      score: number; // 0–10
      feedback?: string;
      survey_type?: string;
      metadata?: Record<string, any>;
    },
  ) {
    if (data.score < 0 || data.score > 10) {
      throw new Error("NPS score must be between 0 and 10");
    }

    const category = categorize(data.score);

    const { data: response, error } = await supabase
      .from("nps_responses")
      .insert({
        ...data,
        category,
        survey_type: data.survey_type || "general",
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return response;
  }

  /**
   * List NPS responses
   */
  async listResponses(
    supabase: SupabaseClient,
    params: {
      category?: string;
      survey_type?: string;
      page?: number;
      limit?: number;
      from?: string;
      to?: string;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 50;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("nps_responses")
      .select("*", { count: "exact" })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (params.category && params.category !== "all")
      query = query.eq("category", params.category);
    if (params.survey_type)
      query = query.eq("survey_type", params.survey_type);
    if (params.from) query = query.gte("created_at", params.from);
    if (params.to) query = query.lte("created_at", params.to);

    const { data, count, error } = await query;
    if (error) throw new Error(error.message);
    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Compute NPS score and summary
   */
  async getSummary(
    supabase: SupabaseClient,
    from?: string,
    to?: string,
  ) {
    let query = supabase
      .from("nps_responses")
      .select("score, category");

    if (from) query = query.gte("created_at", from);
    if (to) query = query.lte("created_at", to);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    const responses = data || [];
    const total = responses.length;

    if (total === 0) {
      return {
        nps_score: null,
        total_responses: 0,
        promoters: 0,
        passives: 0,
        detractors: 0,
        avg_score: null,
      };
    }

    const promoters = responses.filter((r) => r.category === "promoter").length;
    const passives = responses.filter((r) => r.category === "passive").length;
    const detractors = responses.filter((r) => r.category === "detractor").length;

    const npsScore = Math.round(
      ((promoters - detractors) / total) * 100,
    );

    const avgScore =
      responses.reduce((sum, r) => sum + r.score, 0) / total;

    return {
      nps_score: npsScore,
      total_responses: total,
      promoters,
      passives,
      detractors,
      avg_score: Math.round(avgScore * 10) / 10,
    };
  }

  /**
   * Get recent qualitative feedback
   */
  async getQualitativeFeedback(
    supabase: SupabaseClient,
    category?: NPSCategory,
    limit = 20,
  ) {
    let query = supabase
      .from("nps_responses")
      .select("*")
      .not("feedback", "is", null)
      .neq("feedback", "")
      .order("created_at", { ascending: false })
      .limit(limit);

    if (category) query = query.eq("category", category);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  }
}

export const npsService = new NPSService();
