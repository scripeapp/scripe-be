import { SupabaseClient } from "@supabase/supabase-js";
import {
  fetchPaystackTransaction,
  listPaystackTransactions,
} from "../utils/paystack.util";

class PaymentService {
  /**
   * Fetch the full Paystack record for a reference — any status (success,
   * failed, abandoned). Used by public order-success pages and admin tooling;
   * the caller decides what a non-success status means.
   */
  async verifyTransaction(
    _supabase: SupabaseClient,
    reference: string,
  ): Promise<Record<string, unknown>> {
    const data = await fetchPaystackTransaction(reference);
    return data as unknown as Record<string, unknown>;
  }

  /**
   * List a business's store checkout payment records (store_orders), most
   * recent first. This is the "Payments" transaction table shown on the
   * business dashboard — scoped to store orders specifically (the only
   * source that tracks a payment channel) rather than the mixed-source
   * business_revenue_ledger_view used by FinancialsService, so status and
   * channel stay a single coherent vocabulary. Modeled on
   * BankingService.listTransactions.
   */
  async listPaymentTransactions(
    supabase: SupabaseClient,
    businessId: string,
    page = 1,
    limit = 50,
  ): Promise<{ data: Array<Record<string, unknown>>; totalCount: number }> {
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data, count, error } = await supabase
      .from("store_orders")
      .select(
        "id, order_number, customer_name, customer_email, status, payment_reference, payment_method, total, currency, created_at, stores!inner(business_id)",
        { count: "exact" },
      )
      .eq("stores.business_id", businessId)
      .order("created_at", { ascending: false })
      .range(from, to);

    if (error) throw error;

    const transactions = (data ?? []).map(({ stores, ...order }) => order);
    return { data: transactions, totalCount: count ?? 0 };
  }

  /**
   * List Paystack transactions for the logged-in user's own subscription
   * customer code. Refuses to return anything when the user has no customer
   * code — callers must never pass a customer code from the client.
   */
  async getBillingHistory(
    supabase: SupabaseClient,
    userId: string,
  ): Promise<{
    transactions: Array<Record<string, unknown>>;
    meta: Record<string, unknown>;
  }> {
    const { data: profile, error } = await supabase
      .from("users")
      .select("subscription_reference")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw new Error(error.message);

    const customerCode = profile?.subscription_reference as
      | string
      | null
      | undefined;
    if (!customerCode) {
      throw new Error("No billing reference found for this user");
    }

    const { transactions, meta } = await listPaystackTransactions({
      customer: customerCode,
      perPage: 50,
    });

    return {
      transactions: transactions as unknown as Array<Record<string, unknown>>,
      meta: meta as unknown as Record<string, unknown>,
    };
  }
}

export default new PaymentService();
