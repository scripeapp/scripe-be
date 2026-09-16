import { SupabaseClient } from "@supabase/supabase-js";

export interface FeatureFlag {
  id: string;
  key: string;
  name: string;
  description?: string;
  enabled: boolean;
  rollout_percentage: number; // 0–100
  allowed_plans?: string[];   // e.g. ['pro', 'plus']
  allowed_business_ids?: string[];
  metadata?: Record<string, any>;
  created_at: string;
  updated_at: string;
}

export class FeatureFlagsService {
  /**
   * Create a feature flag
   */
  async createFlag(
    supabase: SupabaseClient,
    data: {
      key: string;
      name: string;
      description?: string;
      rollout_percentage?: number;
      allowed_plans?: string[];
      metadata?: Record<string, any>;
    },
  ) {
    const { data: flag, error } = await supabase
      .from("feature_flags")
      .insert({
        ...data,
        enabled: false,
        rollout_percentage: data.rollout_percentage ?? 0,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    return flag;
  }

  /**
   * List all feature flags
   */
  async listFlags(
    supabase: SupabaseClient,
    params: { search?: string; enabled_only?: boolean } = {},
  ) {
    let query = supabase
      .from("feature_flags")
      .select("*")
      .order("created_at", { ascending: false });

    if (params.enabled_only) query = query.eq("enabled", true);
    if (params.search) query = query.ilike("name", `%${params.search}%`);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data || [];
  }

  /**
   * Get a single feature flag by key
   */
  async getFlag(supabase: SupabaseClient, key: string) {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("*")
      .eq("key", key)
      .single();

    if (error) throw new Error(error.message);
    return data as FeatureFlag;
  }

  /**
   * Update a feature flag
   */
  async updateFlag(
    supabase: SupabaseClient,
    id: string,
    data: Partial<Pick<FeatureFlag, "name" | "description" | "enabled" | "rollout_percentage" | "allowed_plans" | "allowed_business_ids" | "metadata">>,
  ) {
    const { data: flag, error } = await supabase
      .from("feature_flags")
      .update(data)
      .eq("id", id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return flag;
  }

  /**
   * Delete a feature flag
   */
  async deleteFlag(supabase: SupabaseClient, id: string) {
    const { error } = await supabase
      .from("feature_flags")
      .delete()
      .eq("id", id);

    if (error) throw new Error(error.message);
  }

  /**
   * Check if a feature is enabled for a specific business
   * Uses percentage rollout + plan restrictions
   */
  async isEnabled(
    supabase: SupabaseClient,
    key: string,
    context: {
      business_id?: string;
      plan?: string;
    },
  ): Promise<boolean> {
    try {
      const flag = await this.getFlag(supabase, key);
      if (!flag.enabled) return false;

      // Plan restriction
      if (flag.allowed_plans && flag.allowed_plans.length > 0) {
        if (!context.plan || !flag.allowed_plans.includes(context.plan)) {
          return false;
        }
      }

      // Specific business allowlist
      if (flag.allowed_business_ids && flag.allowed_business_ids.length > 0) {
        return context.business_id
          ? flag.allowed_business_ids.includes(context.business_id)
          : false;
      }

      // Percentage rollout using deterministic hash
      if (flag.rollout_percentage < 100) {
        const seed = context.business_id || "anonymous";
        const hash = seed
          .split("")
          .reduce((acc, c) => (acc << 5) - acc + c.charCodeAt(0), 0);
        const bucket = Math.abs(hash) % 100;
        return bucket < flag.rollout_percentage;
      }

      return true;
    } catch {
      return false;
    }
  }
}

export const featureFlagsService = new FeatureFlagsService();
