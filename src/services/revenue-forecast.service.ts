import { SupabaseClient } from "@supabase/supabase-js";

const PLAN_PRICES: Record<string, number> = {
  starter: 0,
  plus: 4000,
  pro: 7500,
};

export class RevenueForecastService {
  /**
   * Get historical MRR data points
   */
  private async getHistoricalMRR(supabase: SupabaseClient, months = 6) {
    const points: { month: string; mrr: number }[] = [];
    const now = new Date();

    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const month = d.toISOString().slice(0, 7); // YYYY-MM

      const { data } = await supabase
        .from("businesses")
        .select("subscription_plan, subscription_status")
        .lte("created_at", new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString())
        .eq("subscription_status", "active");

      const mrr = (data || []).reduce(
        (sum, b) => sum + (PLAN_PRICES[b.subscription_plan] || 0),
        0,
      );
      points.push({ month, mrr });
    }

    return points;
  }

  /**
   * Generate a revenue forecast using linear regression on historical MRR
   */
  async getForecast(
    supabase: SupabaseClient,
    forecastMonths = 6,
    historyMonths = 6,
  ) {
    const historical = await this.getHistoricalMRR(supabase, historyMonths);
    const n = historical.length;

    if (n < 2) {
      return {
        historical,
        forecast: [],
        growth_rate: null,
        note: "Not enough historical data for forecasting",
      };
    }

    // Linear regression
    const xMean = (n - 1) / 2;
    const yMean = historical.reduce((s, p) => s + p.mrr, 0) / n;

    let numerator = 0;
    let denominator = 0;
    historical.forEach((p, i) => {
      numerator += (i - xMean) * (p.mrr - yMean);
      denominator += Math.pow(i - xMean, 2);
    });

    const slope = denominator !== 0 ? numerator / denominator : 0;
    const intercept = yMean - slope * xMean;

    // Monthly growth rate %
    const lastMRR = historical[n - 1].mrr;
    const growthRate =
      lastMRR > 0 ? Math.round((slope / lastMRR) * 100 * 10) / 10 : 0;

    // Generate forecast points
    const forecast: { month: string; mrr: number; is_forecast: true }[] = [];
    const now = new Date();

    for (let i = 1; i <= forecastMonths; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const month = d.toISOString().slice(0, 7);
      const predictedMRR = Math.max(
        0,
        Math.round(intercept + slope * (n - 1 + i)),
      );
      forecast.push({ month, mrr: predictedMRR, is_forecast: true });
    }

    return {
      historical,
      forecast,
      growth_rate: growthRate,
      projected_arr_6m: forecast[forecast.length - 1]?.mrr * 12 || 0,
    };
  }

  /**
   * Get current MRR and ARR
   */
  async getCurrentMRR(supabase: SupabaseClient) {
    const { data } = await supabase
      .from("businesses")
      .select("subscription_plan")
      .eq("subscription_status", "active");

    const mrr = (data || []).reduce(
      (sum, b) => sum + (PLAN_PRICES[b.subscription_plan] || 0),
      0,
    );

    return { mrr, arr: mrr * 12 };
  }
}

export const revenueForecastService = new RevenueForecastService();
