import { SupabaseClient } from "@supabase/supabase-js";
import { initializePaystackPayment } from "../utils/paystack.util";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";
import { getChannelCreditRates } from "./channel-message-cost.service";

export type CampaignCreditPackage = {
  id: string;
  credits: number;
  amount: number;
  currency: "NGN";
  label: string;
};

const NAIRA_PER_CREDIT = Number(process.env.CAMPAIGN_CREDIT_NAIRA_PER_CREDIT || 1);

export const CAMPAIGN_CREDIT_PACKAGES: CampaignCreditPackage[] = [
  {
    id: "credits_1000",
    credits: 1000,
    amount: 1000 * NAIRA_PER_CREDIT,
    currency: "NGN",
    label: "1,000 credits",
  },
  {
    id: "credits_5000",
    credits: 5000,
    amount: 5000 * NAIRA_PER_CREDIT,
    currency: "NGN",
    label: "5,000 credits",
  },
  {
    id: "credits_20000",
    credits: 20000,
    amount: 20000 * NAIRA_PER_CREDIT,
    currency: "NGN",
    label: "20,000 credits",
  },
];

export class CampaignCreditsService {
  constructor(private readonly supabase: SupabaseClient) {}

  getPackages(): CampaignCreditPackage[] {
    return CAMPAIGN_CREDIT_PACKAGES;
  }

  async getAccount(businessId: string) {
    const { data: account, error } = await this.supabase
      .from("campaign_credit_accounts")
      .select("business_id, balance, created_at, updated_at")
      .eq("business_id", businessId)
      .maybeSingle();

    if (error) throw error;

    const { data: allTransactions, error: txError } = await this.supabase
      .from("campaign_credit_transactions")
      .select(
        "id, business_id, type, amount, balance_after, paystack_reference, campaign_id, metadata, created_by, created_at",
      )
      .eq("business_id", businessId)
      .order("created_at", { ascending: false });

    if (txError) throw txError;

    const transactions = allTransactions ?? [];
    const totalPurchased = transactions.reduce(
      (total, transaction) =>
        total + (transaction.type === "topup" ? transaction.amount : 0),
      0,
    );
    const totalUsed = transactions.reduce(
      (total, transaction) =>
        total +
        (transaction.type === "debit" ? transaction.amount : 0) -
        (transaction.type === "refund" ? transaction.amount : 0),
      0,
    );

    return {
      balance: account?.balance ?? 0,
      total_purchased: totalPurchased,
      total_used: Math.max(0, totalUsed),
      packages: this.getPackages(),
      rates: getChannelCreditRates(),
      recent_transactions: transactions.slice(0, 10),
    };
  }

  async initializeTopUp(params: {
    businessId: string;
    userId: string;
    email?: string | null;
    packageId: string;
    callbackUrl?: string;
  }) {
    const selectedPackage = CAMPAIGN_CREDIT_PACKAGES.find(
      (pkg) => pkg.id === params.packageId,
    );

    if (!selectedPackage) {
      throw Object.assign(new Error("Invalid campaign credit package"), {
        statusCode: 400,
      });
    }

    const { data: profile } = await this.supabase
      .from("profiles")
      .select("email, name")
      .eq("user_id", params.userId)
      .maybeSingle();

    const payerEmail = params.email || profile?.email || null;

    if (!payerEmail) {
      throw Object.assign(
        new Error("Your account email is required before topping up credits."),
        { statusCode: 400 },
      );
    }

    const frontendUrl = process.env.FRONTEND_URL || "https://www.hilaq.com";
    const reference = createTransactionReference(REFERENCE_TYPES.PAYMENT);
    const callbackUrl =
      params.callbackUrl ||
      `${frontendUrl}/dashboard?tab=crm&sub=campaigns&campaignTopup=success`;

    const payment = await initializePaystackPayment(
      selectedPackage.amount,
      payerEmail,
      reference,
      {
        transaction_type: "campaign_credit_topup",
        business_id: params.businessId,
        user_id: params.userId,
        credits: selectedPackage.credits,
        package_id: selectedPackage.id,
        items_total: selectedPackage.amount,
        email: payerEmail,
        full_name: profile?.name,
      },
      callbackUrl,
    );

    return {
      ...payment,
      package: selectedPackage,
    };
  }

  async creditTopUpFromPayment(params: {
    businessId: string;
    userId?: string | null;
    credits: number;
    paystackReference: string;
    amountPaid: number;
    metadata?: Record<string, unknown>;
  }) {
    if (!params.businessId || !params.credits || params.credits <= 0) {
      throw Object.assign(new Error("Invalid campaign credit top-up metadata"), {
        statusCode: 400,
      });
    }

    const { data, error } = await this.supabase.rpc("credit_campaign_account", {
      p_business_id: params.businessId,
      p_amount: params.credits,
      p_paystack_reference: params.paystackReference,
      p_created_by: params.userId || null,
      p_metadata: {
        ...(params.metadata || {}),
        amount_paid: params.amountPaid,
      },
    });

    if (error) throw error;
    return Array.isArray(data) ? data[0] : data;
  }

  async debitForCampaign(params: {
    businessId: string;
    campaignId: string;
    credits: number;
    metadata?: Record<string, unknown>;
  }) {
    const { data, error } = await this.supabase.rpc("debit_campaign_credits", {
      p_business_id: params.businessId,
      p_amount: params.credits,
      p_campaign_id: params.campaignId,
      p_metadata: params.metadata || {},
    });

    if (error) {
      if (error.message?.includes("INSUFFICIENT_CAMPAIGN_CREDITS")) {
        throw Object.assign(
          new Error("Insufficient campaign credits for this send."),
          { statusCode: 402, code: "INSUFFICIENT_CAMPAIGN_CREDITS" },
        );
      }
      throw error;
    }

    return Array.isArray(data) ? data[0] : data;
  }
}
