import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { SUPPORTED_CURRENCIES } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { deriveFlutterwaveCommissionShare } from "../utils/payment/fees";
import { supabaseAdmin } from "../config/supabase";

const TIP_FEE_PERCENT = parseFloat(process.env.TIP_FEE_PERCENT || "10");

/**
 * @desc  Initiate a payment for tipping — supports NGN (Paystack) + GHS/KES/ZAR/USD (Flutterwave)
 * @access public
 * @endpoint POST /api/tips/initiate
 */
export const initiateTipPayment = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const {
    amount, // NGN/major-unit amount (e.g. 2000 for ₦2,000 or $20)
    subaccount_code,
    flw_subaccount_id,
    email,
    currency = "NGN",
    buyer_name,
    recipient_name,
    recipient_email,
    callback_url,
  } = req.body as {
    amount: number;
    subaccount_code: string;
    flw_subaccount_id?: string;
    email: string;
    currency?: string;
    buyer_name?: string;
    recipient_name?: string;
    recipient_email?: string;
    callback_url?: string;
  };

  if (!amount || !subaccount_code || !email) {
    return ApiResponse.error(
      res,
      "amount, subaccount_code and email are required",
    );
  }

  try {
    const { PaymentProviderFactory } = await import(
      "../utils/payment/PaymentProviderFactory"
    );

    const safeCurrency: SupportedCurrency = (SUPPORTED_CURRENCIES as readonly string[]).includes(currency)
      ? (currency as SupportedCurrency)
      : "NGN";

    const provider = PaymentProviderFactory.getProvider(safeCurrency);

    // If flw_subaccount_id not provided by the frontend, look it up from the DB
    // using the Paystack subaccount code — saves the frontend from needing to fetch it separately.
    let resolvedFlwSubaccountId = flw_subaccount_id;
    if (safeCurrency !== "NGN" && !resolvedFlwSubaccountId && subaccount_code) {
      const { data: biz } = await supabaseAdmin
        .from("businesses")
        .select("flw_subaccount_id")
        .eq("paystack_subaccount_code", subaccount_code)
        .maybeSingle();
      resolvedFlwSubaccountId = biz?.flw_subaccount_id ?? undefined;
    }

    if (safeCurrency !== "NGN" && !resolvedFlwSubaccountId) {
      return ApiResponse.error(
        res,
        "This creator has not set up multi-currency payments yet.",
        422,
      );
    }

    // Tipper pays exactly the stated amount — no gross-up.
    // Hilaq + provider combined take TIP_FEE_PERCENT (10%), guaranteeing recipient nets 90%.
    const totalFee = amount * (TIP_FEE_PERCENT / 100);
    const flwMerchantAmount = deriveFlutterwaveCommissionShare({
      chargeAmount: amount,
      merchantPercent: 100 - TIP_FEE_PERCENT,
      currency: safeCurrency,
    });

    // For Paystack (NGN): transactionCharge = totalFee - paystackFee so recipient nets exactly 90%.
    // For Flutterwave: transactionCharge is ignored; flwMerchantAmount handles the split instead.
    let transactionCharge: number | undefined;
    if (safeCurrency === "NGN") {
      const paystackFee = Math.min(amount * 0.015 + (amount >= 2500 ? 100 : 0), 2000);
      const platformFee = Math.max(Number((totalFee - paystackFee).toFixed(2)), 0);
      transactionCharge = Math.round(platformFee * 100);
    }

    const reference =
      safeCurrency === "NGN"
        ? `TIP-${Date.now()}`
        : `FLW-TIP-${Date.now()}`;

    const metadata = {
      transaction_type: "tipping" as const,
      payment_name: `Tipping ${recipient_name || ""}`,
      payment_type: "tipping",
      custom_fields: [
        { display_name: "Buyer Name", variable_name: "buyer_name", value: buyer_name || "" },
        { display_name: "Buyer Email", variable_name: "buyer_email", value: email },
        { display_name: "Recipient Name", variable_name: "recipient_name", value: recipient_name || "" },
        { display_name: "Recipient Email", variable_name: "recipient_email", value: recipient_email || "" },
      ],
    };

    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";
    const callbackUrl =
      callback_url || `${frontendUrl}/profile?tip_success=1`;

    const result = await provider.initializePayment({
      amount,
      email,
      currency: safeCurrency,
      reference,
      metadata,
      callbackUrl,
      customerName: buyer_name,
      subaccountCode: subaccount_code,
      bearer: "subaccount",
      transactionCharge,
      flwSubaccountId: resolvedFlwSubaccountId,
      flwMerchantAmount,
    });

    return ApiResponse.success(res, "Payment initialized", {
      authorization_url: result.authorization_url,
      reference: result.reference,
    });
  } catch (error: any) {
    console.error("[initiateTipPayment] Error:", error);
    return ApiResponse.error(
      res,
      error?.message || "Failed to initiate tip payment",
    );
  }
};
