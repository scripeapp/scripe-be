import { SupabaseClient } from "@supabase/supabase-js";

export interface HealthScore {
  business_id: string;
  score: number;           // 0–100
  tier: "champion" | "healthy" | "at_risk" | "critical";
  factors: {
    subscription_active: boolean;
    plan: string;
    days_since_last_login: number | null;
    has_products: boolean;
    has_stores: boolean;
    payment_healthy: boolean;
    kyc_verified: boolean;
    upgrade_signal_count: number;
    dunning_active: boolean;
  };
  computed_at: string;
}

const TIER_THRESHOLDS = {
  champion: 80,
  healthy: 55,
  at_risk: 30,
};

function scoreToTier(score: number): HealthScore["tier"] {
  if (score >= TIER_THRESHOLDS.champion) return "champion";
  if (score >= TIER_THRESHOLDS.healthy) return "healthy";
  if (score >= TIER_THRESHOLDS.at_risk) return "at_risk";
  return "critical";
}

export class CustomerHealthService {
  /**
   * Compute health score for a single business
   */
  async computeScore(
    supabase: SupabaseClient,
    businessId: string,
  ): Promise<HealthScore> {
    const [bizRes, productsRes, storesRes, dunningRes, upgradeRes] =
      await Promise.all([
        supabase
          .from("businesses")
          .select("id, subscription_plan, subscription_status, last_login_at, is_verified, owner_id")
          .eq("id", businessId)
          .single(),
        supabase
          .from("products")
          .select("id", { count: "exact" })
          .eq("business_id", businessId)
          .limit(1),
        supabase
          .from("stores")
          .select("id", { count: "exact" })
          .eq("business_id", businessId)
          .limit(1),
        supabase
          .from("subscription_dunning")
          .select("id", { count: "exact" })
          .eq("business_id", businessId)
          .eq("status", "active"),
        supabase
          .from("plan_upgrade_signals")
          .select("id", { count: "exact" })
          .eq("business_id", businessId),
      ]);

    const biz = bizRes.data;
    if (!biz) throw new Error("Business not found");

    const subscriptionActive = biz.subscription_status === "active";
    const plan = biz.subscription_plan || "starter";
    const hasProducts = (productsRes.count || 0) > 0;
    const hasStores = (storesRes.count || 0) > 0;
    const paymentHealthy = (dunningRes.count || 0) === 0;
    const kycVerified = biz.is_verified || false;
    const upgradeSignalCount = upgradeRes.count || 0;
    const dunningActive = (dunningRes.count || 0) > 0;

    let daysSinceLastLogin: number | null = null;
    if (biz.last_login_at) {
      daysSinceLastLogin = Math.floor(
        (Date.now() - new Date(biz.last_login_at).getTime()) / 86400000,
      );
    }

    // Scoring
    let score = 0;

    // Subscription (30 pts)
    if (subscriptionActive) score += 20;
    if (plan === "pro") score += 10;
    else if (plan === "plus") score += 5;

    // Engagement (25 pts)
    if (daysSinceLastLogin !== null) {
      if (daysSinceLastLogin <= 7) score += 25;
      else if (daysSinceLastLogin <= 14) score += 18;
      else if (daysSinceLastLogin <= 30) score += 10;
      else if (daysSinceLastLogin <= 60) score += 5;
    }

    // Product setup (20 pts)
    if (hasProducts) score += 12;
    if (hasStores) score += 8;

    // Payment health (15 pts)
    if (paymentHealthy) score += 15;
    else score -= 10;

    // KYC (10 pts)
    if (kycVerified) score += 10;

    // Upgrade signals (deducted)
    score -= Math.min(upgradeSignalCount * 3, 15);

    score = Math.max(0, Math.min(100, score));

    return {
      business_id: businessId,
      score: Math.round(score),
      tier: scoreToTier(score),
      factors: {
        subscription_active: subscriptionActive,
        plan,
        days_since_last_login: daysSinceLastLogin,
        has_products: hasProducts,
        has_stores: hasStores,
        payment_healthy: paymentHealthy,
        kyc_verified: kycVerified,
        upgrade_signal_count: upgradeSignalCount,
        dunning_active: dunningActive,
      },
      computed_at: new Date().toISOString(),
    };
  }

  /**
   * Get health scores for multiple businesses (paginated)
   */
  async getHealthOverview(
    supabase: SupabaseClient,
    params: {
      tier?: string;
      page?: number;
      limit?: number;
    } = {},
  ) {
    const page = params.page || 1;
    const limit = params.limit || 20;
    const offset = (page - 1) * limit;

    let query = supabase
      .from("business_health_scores")
      .select("*", { count: "exact" })
      .order("score", { ascending: true })
      .range(offset, offset + limit - 1);

    if (params.tier && params.tier !== "all") {
      query = query.eq("tier", params.tier);
    }

    const { data, count, error } = await query;
    if (error) {
      // Fallback: compute for top businesses
      return { data: [], total: 0, page, limit, note: "health_scores table not yet populated" };
    }

    return { data: data || [], total: count || 0, page, limit };
  }

  /**
   * Tier distribution summary
   */
  async getTierSummary(supabase: SupabaseClient) {
    const tiers = ["champion", "healthy", "at_risk", "critical"] as const;
    const results = await Promise.all(
      tiers.map((t) =>
        supabase
          .from("business_health_scores")
          .select("id", { count: "exact" })
          .eq("tier", t),
      ),
    );

    return Object.fromEntries(
      tiers.map((t, i) => [t, results[i].count || 0]),
    );
  }
}

export const customerHealthService = new CustomerHealthService();
