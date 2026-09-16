import { SupabaseClient } from "@supabase/supabase-js";
import supabaseAdmin from "../config/supabaseAdmin";
import { emailService } from "./email.service";
import { adminAlertsService } from "./admin-alerts.service";

export interface TransactionSummary {
  gross_revenue: number;
  net_revenue: number;
  total_expenses: number;
  net_profit: number;
  refunds_total: number;
  platform_fees: number;
  transaction_count: number;
  revenue_by_source: { source: string; amount: number }[];
  revenue_chart: { date: string; value: number }[];
  expenses_chart: { date: string; value: number }[];
}

export interface SettlementSummary {
  pending_amount: number;
  settled_amount: number;
  history: SettlementHistoryItem[];
}

export interface SettlementHistoryItem {
  id: number;
  amount: number;
  effective_amount: number;
  fees: number;
  status: string;
  currency: string;
  settlement_date: string;
}

export interface LedgerFilter {
  startDate?: string;
  endDate?: string;
  source?:
    | "store"
    | "event"
    | "subscription"
    | "circle_subscription"
    | "scheduling_payment"
    | "scheduling"
    | "manual";
  status?: string;
  customer?: string;
  amountMin?: number;
  amountMax?: number;
}

export interface ExpenseFilter {
  startDate?: string;
  endDate?: string;
  category?: string;
  amountMin?: number;
  amountMax?: number;
}

export class FinancialsService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get unified financial summary for a business
   */
  async getSummary(
    businessId: string,
    filters: LedgerFilter = {},
  ): Promise<TransactionSummary> {
    const { startDate, endDate } = filters;

    // 1. Get Revenue from View
    let revenueQuery = this.supabase
      .from("business_revenue_ledger_view")
      .select("amount, created_at, source")
      .eq("business_id", businessId)
      .eq("status", "paid"); // Default to successful payments

    if (startDate) revenueQuery = revenueQuery.gte("created_at", startDate);
    if (endDate) revenueQuery = revenueQuery.lte("created_at", endDate);

    const { data: revenueData, error: revenueError } = await revenueQuery;
    if (revenueError) throw revenueError;

    const grossRevenue = (revenueData || []).reduce(
      (sum, item) => sum + Number(item.amount),
      0,
    );

    // 2. Get Refunds
    let refundQuery = this.supabase
      .from("financial_refunds")
      .select("amount")
      .eq("business_id", businessId)
      .eq("status", "processed");

    if (startDate) refundQuery = refundQuery.gte("created_at", startDate);
    if (endDate) refundQuery = refundQuery.lte("created_at", endDate);

    const { data: refundData, error: refundError } = await refundQuery;
    if (refundError) throw refundError;

    const totalRefunds = (refundData || []).reduce(
      (sum, item) => sum + Number(item.amount),
      0,
    );

    // 3. Get Expenses
    let expenseQuery = this.supabase
      .from("expenses")
      .select("amount, transaction_date")
      .eq("business_id", businessId);

    if (startDate)
      expenseQuery = expenseQuery.gte("transaction_date", startDate);
    if (endDate) expenseQuery = expenseQuery.lte("transaction_date", endDate);

    const { data: expenseData, error: expenseError } = await expenseQuery;
    if (expenseError) throw expenseError;

    const totalExpenses = (expenseData || []).reduce(
      (sum, item) => sum + Number(item.amount),
      0,
    );

    // 4. Calculate Net & Fees
    const netRevenue = grossRevenue - totalRefunds;
    const netProfit = netRevenue - totalExpenses;

    // Estimate platform fees if not tracked (Paystack: 1.5% + ₦100 with ₦2000 cap on 1.5%)
    // This is a rough estimation for the summary
    const platformFees = (revenueData || []).reduce((sum, item) => {
      const amt = Number(item.amount);
      const percentageFee = Math.min(amt * 0.015, 2000);
      const flatFee = amt > 2500 ? 100 : 0;
      return sum + percentageFee + flatFee;
    }, 0);

    // 5. Generate Chart Data
    const revenueChart = this.aggregateByDate(
      revenueData || [],
      "amount",
      "created_at",
    );
    const expensesChart = this.aggregateByDate(
      expenseData || [],
      "amount",
      "transaction_date",
    );

    // 6. Revenue by source breakdown
    const sourceMap: Record<string, number> = {};
    (revenueData || []).forEach((item) => {
      const src = item.source || "other";
      sourceMap[src] = (sourceMap[src] || 0) + Number(item.amount);
    });
    const revenueBySource = Object.entries(sourceMap).map(
      ([source, amount]) => ({
        source,
        amount,
      }),
    );

    return {
      gross_revenue: grossRevenue,
      net_revenue: netRevenue,
      total_expenses: totalExpenses,
      net_profit: netProfit,
      refunds_total: totalRefunds,
      platform_fees: platformFees,
      transaction_count: (revenueData || []).length,
      revenue_by_source: revenueBySource,
      revenue_chart: revenueChart,
      expenses_chart: expensesChart,
    };
  }

  private aggregateByDate(
    data: any[],
    valueKey: string | null,
    dateKey: string = "created_at",
  ): { date: string; value: number }[] {
    const grouped: Record<string, number> = {};

    data.forEach((item) => {
      const rawDate = item[dateKey] || item.created_at;
      if (!rawDate) return;
      const date = new Date(rawDate).toISOString().split("T")[0]; // YYYY-MM-DD
      const value = valueKey ? Number(item[valueKey] || 0) : 1;
      grouped[date] = (grouped[date] || 0) + value;
    });

    return Object.entries(grouped)
      .map(([date, value]) => ({ date, value }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Get detailed transaction ledger
   */
  async getLedger(
    businessId: string,
    filters: LedgerFilter = {},
    page = 1,
    limit = 50,
  ) {
    let query = this.supabase
      .from("business_revenue_ledger_view")
      .select("*", { count: "exact" })
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (filters.startDate) query = query.gte("created_at", filters.startDate);
    if (filters.endDate) query = query.lte("created_at", filters.endDate);
    if (filters.source) query = query.eq("source", filters.source);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.customer) {
      query = query.or(
        `customer_name.ilike.%${filters.customer}%,customer_email.ilike.%${filters.customer}%`,
      );
    }
    if (filters.amountMin) query = query.gte("amount", filters.amountMin);
    if (filters.amountMax) query = query.lte("amount", filters.amountMax);

    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await query.range(from, to);
    if (error) throw error;

    return { data, totalCount: count };
  }

  /**
   * EXPENSES Management
   */
  async createExpense(businessId: string, expenseData: any) {
    const { data, error } = await this.supabase
      .from("expenses")
      .insert({ ...expenseData, business_id: businessId })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async getExpenses(businessId: string, filters: ExpenseFilter = {}) {
    let query = this.supabase
      .from("expenses")
      .select("*")
      .eq("business_id", businessId)
      .order("transaction_date", { ascending: false });

    if (filters.startDate)
      query = query.gte("transaction_date", filters.startDate);
    if (filters.endDate) query = query.lte("transaction_date", filters.endDate);
    if (filters.category) query = query.eq("category", filters.category);
    if (filters.amountMin) query = query.gte("amount", filters.amountMin);
    if (filters.amountMax) query = query.lte("amount", filters.amountMax);

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async updateExpense(businessId: string, expenseId: string, expenseData: any) {
    const { data, error } = await this.supabase
      .from("expenses")
      .update(expenseData)
      .eq("id", expenseId)
      .eq("business_id", businessId)
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  async deleteExpense(businessId: string, expenseId: string) {
    const { error } = await this.supabase
      .from("expenses")
      .delete()
      .eq("id", expenseId)
      .eq("business_id", businessId);
    if (error) throw error;
    return { success: true };
  }

  /**
   * REFUNDS Management
   */
  async createRefund(businessId: string, refundData: any) {
    const { data, error } = await this.supabase
      .from("financial_refunds")
      .insert({ ...refundData, business_id: businessId })
      .select()
      .single();
    if (error) throw error;
    return data;
  }

  /**
   * Real settlement figures for a business's Paystack subaccount.
   * Paystack amounts are in kobo, so they are converted to naira here.
   */
  async getSettlements(businessId: string): Promise<SettlementSummary> {
    const empty: SettlementSummary = {
      pending_amount: 0,
      settled_amount: 0,
      history: [],
    };

    const subaccountId = await this.resolveSubaccountId(businessId);
    if (!subaccountId) return empty;

    const { listPaystackSettlements } = await import("../utils/paystack.util");
    const { settlements } = await listPaystackSettlements({
      subaccount: subaccountId,
      perPage: 100,
    });

    const toNaira = (kobo: number) => Number(kobo) / 100;
    const isPending = (status: string) =>
      ["pending", "processing", "queued"].includes(status.toLowerCase());

    const pendingAmount = settlements
      .filter((settlement) => isPending(settlement.status))
      .reduce((sum, settlement) => sum + toNaira(settlement.total_amount), 0);

    const settledAmount = settlements
      .filter((settlement) => settlement.status.toLowerCase() === "success")
      .reduce(
        (sum, settlement) => sum + toNaira(settlement.effective_amount),
        0,
      );

    const history: SettlementHistoryItem[] = settlements.map((settlement) => ({
      id: settlement.id,
      amount: toNaira(settlement.total_amount),
      effective_amount: toNaira(settlement.effective_amount),
      fees: toNaira(settlement.total_fees),
      status: settlement.status,
      currency: settlement.currency,
      settlement_date: settlement.settlement_date,
    }));

    return { pending_amount: pendingAmount, settled_amount: settledAmount, history };
  }

  private async resolveSubaccountId(
    businessId: string,
  ): Promise<string | null> {
    const { data } = await this.supabase
      .from("businesses")
      .select("paystack_subaccount_id, paystack_subaccount_code")
      .eq("id", businessId)
      .single();

    if (data?.paystack_subaccount_id) return String(data.paystack_subaccount_id);
    if (!data?.paystack_subaccount_code) return null;

    const { fetchPaystackSubaccount } = await import("../utils/paystack.util");
    const subaccount = await fetchPaystackSubaccount(
      data.paystack_subaccount_code,
    );
    return subaccount?.id ? String(subaccount.id) : null;
  }

  /**
   * A business's own payout request history.
   */
  async getPayoutRequests(businessId: string) {
    const { data, error } = await this.supabase
      .from("payout_requests")
      .select("*")
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data;
  }

  /**
   * Record a merchant payout request and notify admins. The request stays
   * `pending` until a Paystack settlement webhook marks it fulfilled/failed.
   * Amount is validated > 0 and de-duplicated against any open request; the
   * displayed Paystack pending figure caps the amount in the UI, and ops
   * verifies the real balance in Paystack before settling.
   */
  async requestPayout(businessId: string, requestedBy: string, amount: number) {
    if (!Number.isFinite(amount) || amount <= 0) {
      throw Object.assign(new Error("Enter a valid payout amount"), {
        statusCode: 400,
      });
    }

    await this.assertNoOpenPayoutRequest(businessId);

    const { data, error } = await this.supabase
      .from("payout_requests")
      .insert({
        business_id: businessId,
        requested_by: requestedBy,
        amount,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw error;

    await this.notifyAdminsOfPayoutRequest(businessId, amount);
    return data;
  }

  private async assertNoOpenPayoutRequest(businessId: string): Promise<void> {
    const { data, error } = await this.supabase
      .from("payout_requests")
      .select("id")
      .eq("business_id", businessId)
      .eq("status", "pending")
      .limit(1);
    if (error) throw error;

    if (data && data.length > 0) {
      throw Object.assign(
        new Error("You already have a pending payout request"),
        { statusCode: 409 },
      );
    }
  }

  /**
   * Best-effort admin notification — never fails the payout request itself.
   */
  private async notifyAdminsOfPayoutRequest(
    businessId: string,
    amount: number,
  ): Promise<void> {
    const adminClient = supabaseAdmin || this.supabase;
    try {
      const { data: business } = await adminClient
        .from("businesses")
        .select("name")
        .eq("id", businessId)
        .single();
      const businessName = business?.name || "A business";

      await adminAlertsService.createAlert(adminClient, {
        type: "payout_request",
        severity: "info",
        title: `Payout request: ₦${amount.toLocaleString()}`,
        message: `${businessName} requested a payout of ₦${amount.toLocaleString()}`,
        metadata: { businessId, amount },
      });

      const { data: admins } = await adminClient
        .from("admin_users")
        .select("email")
        .eq("is_active", true)
        .in("role", ["super_admin", "finance"]);

      await Promise.all(
        (admins || []).map((admin) =>
          emailService.sendPayoutRequestEmail({
            to: admin.email,
            businessName,
            amount,
          }),
        ),
      );
    } catch (err) {
      console.error("[requestPayout] Admin notification failed:", err);
    }
  }
}
