import axios from "axios";
import { randomUUID } from "crypto";
import supabaseAdmin from "../../config/supabaseAdmin";
import {
  derivePaymentType,
  persistPendingCheckoutQuietly,
} from "../../services/pending-checkout.service";
import type {
  CalculateFeesResult,
  IPaymentProvider,
  InitPaymentParams,
  NormalisedPaymentData,
  SupportedCurrency,
} from "./types";
import {
  calculateFlutterwaveGatewayFee,
  getPlatformFeePercent,
  isFlutterwaveSupportedCurrency,
} from "./fees";

const FLW_API_URL = "https://api.flutterwave.com/v3";

function getSecretKey(): string {
  const key = process.env.FLW_SECRET_KEY;
  if (!key) throw new Error("FLW_SECRET_KEY is not configured");
  return key;
}

/**
 * Namespaces every Flutterwave tx_ref under "FLW-". Callers persist the
 * reference this returns, so PaymentProviderFactory.getProviderForReference
 * can route later verifications by prefix — keep that chain intact.
 */
function normalizeFlutterwaveReference(reference?: string): string {
  if (!reference) return `FLW-${randomUUID()}`;
  return reference.startsWith("FLW-") ? reference : `FLW-${reference}`;
}

export class FlutterwaveProvider implements IPaymentProvider {
  readonly name = "flutterwave" as const;

  async initializePayment(
    params: InitPaymentParams,
  ): Promise<{ authorization_url: string; reference: string }> {
    const ref = normalizeFlutterwaveReference(params.reference);

    // subaccounts carry the merchant's flat credit; Hilaq keeps the rest
    // (opposite of Paystack's transaction_charge). RS_ ids only — stale rows
    // may hold numeric ids, which must not be split on.
    const isRsFormat = params.flwSubaccountId?.startsWith("RS_");
    // equality is legitimate (subaccount-bearer); only > charge settles negative
    const merchantShareExceedsCharge =
      params.flwMerchantAmount != null &&
      params.flwMerchantAmount > params.amount;
    const subaccounts =
      params.flwSubaccountId &&
      isRsFormat &&
      params.flwMerchantAmount != null &&
      !merchantShareExceedsCharge
        ? [
            {
              id: params.flwSubaccountId,
              transaction_charge_type: "flat",
              transaction_charge: params.flwMerchantAmount,
            },
          ]
        : undefined;

    if (merchantShareExceedsCharge) {
      console.warn(
        `[FlutterwaveProvider] flwMerchantAmount ${params.flwMerchantAmount} exceeds charge ${params.amount} — split skipped to avoid negative settlement.`,
      );
    }

    if (params.flwSubaccountId && !isRsFormat) {
      console.warn(
        `[FlutterwaveProvider] flwSubaccountId "${params.flwSubaccountId}" is not RS_xxxx format — ` +
          "subaccount split skipped. Business must re-save settlement account to refresh the stored ID.",
      );
    }

    // FLW meta only accepts primitives — stringify any nested objects/arrays.
    const flatMeta: Record<string, string | number | boolean> = {
      provider: "flutterwave",
    };
    for (const [k, v] of Object.entries(params.metadata)) {
      if (v === null || v === undefined) continue;
      // The full pricing snapshot is canonical in pending_checkouts. Avoid
      // duplicating a potentially large cart snapshot in gateway metadata.
      if (k === "pricing_snapshot") continue;
      flatMeta[k] =
        typeof v === "object"
          ? JSON.stringify(v)
          : (v as string | number | boolean);
    }

    const payload: Record<string, unknown> = {
      // Standard FLW checkout API uses tx_ref, not reference
      tx_ref: ref,
      amount: params.amount,
      currency: params.currency,
      redirect_url: params.callbackUrl ?? "",
      customer: {
        email: params.email,
        name: params.customerName ?? params.metadata.customer_name ?? "",
        phonenumber: params.metadata.customer_phone ?? "",
      },
      meta: flatMeta,
      customizations: {
        title: "Hilaq",
        logo: "https://hilaq.com/favicon.ico",
      },
      ...(subaccounts ? { subaccounts } : {}),
    };

    let response: Awaited<
      ReturnType<
        typeof axios.post<{
          status: string;
          message: string;
          data: { link: string };
        }>
      >
    >;

    try {
      response = await axios.post(`${FLW_API_URL}/payments`, payload, {
        headers: {
          Authorization: `Bearer ${getSecretKey()}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      });
    } catch (axiosErr: any) {
      const flwMessage =
        axiosErr?.response?.data?.message ??
        JSON.stringify(axiosErr?.response?.data) ??
        axiosErr.message;
      throw new Error(`Flutterwave charge failed: ${flwMessage}`);
    }

    const link = response.data.data?.link;
    if (!link) {
      throw new Error(
        "Failed to initialize Flutterwave payment: no redirect URL returned",
      );
    }

    await persistPendingCheckoutQuietly(supabaseAdmin, {
      reference: ref,
      paymentType: derivePaymentType(params.metadata, ref),
      amountKobo: Math.round(params.amount * 100),
      customerEmail: params.email,
      metadata: params.metadata,
    });

    return { authorization_url: link, reference: ref };
  }

  async verifyPayment(reference: string): Promise<NormalisedPaymentData> {
    const response = await axios.get<{
      status: string;
      data: Array<{
        id: number;
        tx_ref: string;
        amount: number;
        app_fee?: number;
        currency: string;
        status: string;
        customer: { name?: string; email?: string; phone_number?: string };
        meta: Record<string, unknown>;
        created_at: string;
        subaccount_id?: string;
      }>;
    }>(`${FLW_API_URL}/transactions?tx_ref=${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${getSecretKey()}` },
      timeout: 10_000,
    });

    const charge = Array.isArray(response.data.data)
      ? response.data.data[0]
      : (response.data.data as any);

    if (!charge || charge.status !== "successful") {
      throw new Error(
        `Flutterwave payment not successful. Status: ${charge?.status ?? "unknown"}`,
      );
    }

    // FLW returns amount in major units; normalise to kobo-equivalent × 100
    // so verifyPaymentAmount() (which divides by 100) works correctly
    const amountInSmallestUnit = Math.round(charge.amount * 100);

    return {
      reference: charge.tx_ref,
      amount: amountInSmallestUnit,
      gatewayFee:
        typeof charge.app_fee === "number"
          ? Math.round(charge.app_fee * 100)
          : undefined,
      status: "success",
      metadata: (charge.meta ??
        {}) as unknown as NormalisedPaymentData["metadata"],
      customer: {
        name: charge.customer.name,
        email: charge.customer.email,
        phone: charge.customer.phone_number,
      },
      currency: charge.currency,
      provider: "flutterwave",
      paidAt: charge.created_at,
      providerSubaccountId: charge.subaccount_id,
      raw: charge as unknown as Record<string, unknown>,
    };
  }

  calculateFees(
    amountInMajorUnit: number,
    currency: string = "NGN",
  ): CalculateFeesResult {
    const curr = isFlutterwaveSupportedCurrency(currency)
      ? (currency as SupportedCurrency)
      : "NGN";

    const platformFee = Number(
      (amountInMajorUnit * getPlatformFeePercent(curr)).toFixed(2),
    );
    const intermediate = amountInMajorUnit + platformFee;
    const fee = calculateFlutterwaveGatewayFee(intermediate, curr);
    const totalToCharge = Number((intermediate + fee).toFixed(2));

    return { totalToCharge, platformFee, fee };
  }

  // HMAC-SHA256 of raw body using FLW_WEBHOOK_HASH as secret,
  // compared against the "verif-hash" header (standard FLW webhook header)
  verifyWebhookSignature(body: string, header: string): boolean {
    const secret = process.env.FLW_WEBHOOK_HASH;
    if (!secret) return false;
    return secret === header;
  }

  normaliseWebhookEvent(body: unknown): NormalisedPaymentData | null {
    const event = body as {
      event?: string;
      data?: {
        tx_ref?: string;
        amount?: number;
        app_fee?: number;
        currency?: string;
        status?: string;
        customer?: { name?: string; email?: string; phone_number?: string };
        meta?: Record<string, unknown>;
        created_at?: string;
        subaccount_id?: string;
      };
    };

    if (event?.event !== "charge.completed" || !event.data) return null;
    if (event.data.status !== "successful") return null;

    const d = event.data;
    const amountInSmallestUnit = Math.round((d.amount ?? 0) * 100);

    return {
      reference: d.tx_ref ?? "",
      amount: amountInSmallestUnit,
      gatewayFee:
        typeof d.app_fee === "number" ? Math.round(d.app_fee * 100) : undefined,
      status: "success",
      metadata: (d.meta ?? {}) as unknown as NormalisedPaymentData["metadata"],
      customer: {
        name: d.customer?.name,
        email: d.customer?.email ?? "",
        phone: d.customer?.phone_number,
      },
      currency: d.currency ?? "",
      provider: "flutterwave",
      paidAt: d.created_at,
      providerSubaccountId: d.subaccount_id,
      raw: d as unknown as Record<string, unknown>,
    };
  }
}
