import { SupabaseClient } from "@supabase/supabase-js";
import { BookkeepingTransaction } from "../types/store";

export interface BookkeepingFilters {
  business_id: string;
  type?: "income" | "expense";
  category?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export class BookkeepingService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Get transaction ledger with filters and pagination
   */
  async getLedger(
    filters: BookkeepingFilters,
  ): Promise<{ items: BookkeepingTransaction[]; total: number }> {
    const {
      business_id,
      type,
      category,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = filters;
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("bookkeeping_transactions")
      .select("*", { count: "exact" })
      .eq("business_id", business_id)
      .order("transaction_date", { ascending: false });

    if (type) query = query.eq("type", type);
    if (category) query = query.eq("category", category);
    if (startDate) query = query.gte("transaction_date", startDate);
    if (endDate) query = query.lte("transaction_date", endDate);

    const { data, error, count } = await query.range(
      offset,
      offset + limit - 1,
    );

    if (error) throw error;

    return {
      items: (data || []) as BookkeepingTransaction[],
      total: count || 0,
    };
  }

  /**
   * Get financial summary (Total Income, Total Expenses, Net Profit)
   */
  async getSummary(
    businessId: string,
    startDate?: string,
    endDate?: string,
  ): Promise<{
    total_income: number;
    total_expenses: number;
    net_profit: number;
    currency: string;
  }> {
    let query = this.supabase
      .from("bookkeeping_transactions")
      .select("type, amount")
      .eq("business_id", businessId);

    if (startDate) query = query.gte("transaction_date", startDate);
    if (endDate) query = query.lte("transaction_date", endDate);

    const { data, error } = await query;

    if (error) throw error;

    let income = 0;
    let expenses = 0;

    (data || []).forEach((t: any) => {
      if (t.type === "income") income += Number(t.amount);
      else if (t.type === "expense") expenses += Number(t.amount);
    });

    return {
      total_income: income,
      total_expenses: expenses,
      net_profit: income - expenses,
      currency: "NGN", // Defaulting to NGN for now
    };
  }

  /**
   * Create a manual transaction
   */
  async createTransaction(
    data: Partial<BookkeepingTransaction>,
  ): Promise<BookkeepingTransaction> {
    const { data: result, error } = await this.supabase
      .from("bookkeeping_transactions")
      .insert([data])
      .select()
      .single();

    if (error) throw error;
    return result as BookkeepingTransaction;
  }

  /**
   * Update an existing transaction
   */
  async updateTransaction(
    id: string,
    businessId: string,
    data: Partial<BookkeepingTransaction>,
  ): Promise<BookkeepingTransaction> {
    const { data: result, error } = await this.supabase
      .from("bookkeeping_transactions")
      .update(data)
      .eq("id", id)
      .eq("business_id", businessId)
      .select()
      .single();

    if (error) throw error;
    return result as BookkeepingTransaction;
  }

  /**
   * Delete a transaction
   */
  async deleteTransaction(id: string, businessId: string): Promise<void> {
    const { error } = await this.supabase
      .from("bookkeeping_transactions")
      .delete()
      .eq("id", id)
      .eq("business_id", businessId);

    if (error) throw error;
  }

  /**
   * Sync a store order as an income transaction
   */
  async syncOrderIncome(order: any): Promise<void> {
    if (order.status !== "paid" && order.status !== "fulfilled") return;

    // Check if already synced
    const { data: existing } = await this.supabase
      .from("bookkeeping_transactions")
      .select("id")
      .eq("reference_id", order.id)
      .eq("reference_type", "store_order")
      .limit(1)
      .single();

    if (existing) return;

    // Get business_id from store_id
    const { data: store } = await this.supabase
      .from("stores")
      .select("business_id")
      .eq("id", order.store_id)
      .single();

    if (!store?.business_id) return;

    await this.createTransaction({
      business_id: store.business_id,
      store_id: order.store_id,
      type: "income",
      category: "Sales",
      amount: order.total,
      currency: order.currency || "NGN",
      description: `Store Order #${order.order_number || order.id.slice(0, 8)}`,
      transaction_date: order.created_at,
      reference_id: order.id,
      reference_type: "store_order",
    });
  }
}
