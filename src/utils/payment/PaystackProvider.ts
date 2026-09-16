import crypto from "crypto";
import {
  initializePaystackPayment,
  initializePaystackBankTransfer,
  verifyPaystackPayment,
} from "../paystack.util";
import { calculateTotalWithFees } from "./fees";
import supabaseAdmin from "../../config/supabaseAdmin";
import {
  derivePaymentType,
  persistPendingCheckoutQuietly,
} from "../../services/pending-checkout.service";
import type {
  BankTransferParams,
  BankTransferResult,
  CalculateFeesResult,
  IPaymentProvider,
  InitPaymentParams,
  NormalisedPaymentData,
} from "./types";

export class PaystackProvider implements IPaymentProvider {
  readonly name = "paystack" as const;

  private gatewayMetadata(metadata: InitPaymentParams["metadata"]) {
    const gatewayMetadata = { ...metadata };
    delete gatewayMetadata.pricing_snapshot;
    return gatewayMetadata;
  }

  async initializePayment(
    params: InitPaymentParams,
  ): Promise<{ authorization_url: string; reference: string }> {
    const result = await initializePaystackPayment(
      params.amount,
      params.email,
      params.reference,
      {
        ...this.gatewayMetadata(params.metadata),
        customer_name: params.customerName ?? params.metadata.customer_name,
      },
      params.callbackUrl,
      params.subaccountCode,
      params.bearer ?? "subaccount",
      params.transactionCharge,
      params.planCode,
    );

    await persistPendingCheckoutQuietly(supabaseAdmin, {
      reference: result.reference,
      paymentType: derivePaymentType(params.metadata, result.reference),
      amountKobo: Math.round(params.amount * 100),
      customerEmail: params.email,
      subaccountCode: params.subaccountCode,
      metadata: params.metadata,
    });

    return result;
  }

  async initiateBankTransfer(
    params: BankTransferParams,
  ): Promise<BankTransferResult> {
    const result = await initializePaystackBankTransfer({
      amount: params.amount,
      email: params.email,
      metadata: this.gatewayMetadata(params.metadata),
      reference: params.reference,
      subaccountCode: params.subaccountCode,
      bearer: params.bearer,
      transactionCharge: params.transactionCharge,
    });

    await persistPendingCheckoutQuietly(supabaseAdmin, {
      reference: result.reference,
      paymentType: derivePaymentType(params.metadata, result.reference),
      amountKobo: Math.round(params.amount * 100),
      customerEmail: params.email,
      subaccountCode: params.subaccountCode,
      metadata: params.metadata,
    });

    return result;
  }

  async verifyPayment(reference: string): Promise<NormalisedPaymentData> {
    const data = await verifyPaystackPayment(reference);
    const subaccountCode =
      typeof data.subaccount === "string"
        ? data.subaccount
        : data.subaccount?.subaccount_code;
    return {
      reference: data.reference,
      amount: data.amount,
      status: data.status,
      metadata: data.metadata,
      customer: {
        name: `${data.customer.first_name ?? ""} ${data.customer.last_name ?? ""}`.trim() || undefined,
        first_name: data.customer.first_name,
        last_name: data.customer.last_name,
        email: data.customer.email,
        phone: data.customer.phone ?? undefined,
      },
      currency: data.currency ?? "NGN",
      provider: "paystack",
      paidAt: data.paid_at,
      authorization: data.authorization,
      channel: data.channel,
      subaccountCode,
      raw: data as unknown as Record<string, unknown>,
    };
  }

  calculateFees(amountInMajorUnit: number): CalculateFeesResult {
    const { totalToCharge, platformFee, paystackFee } =
      calculateTotalWithFees(amountInMajorUnit);
    return { totalToCharge, platformFee, fee: paystackFee };
  }

  verifyWebhookSignature(body: string, header: string): boolean {
    const secret = process.env.PAYSTACK_SECRET_KEY;
    if (!secret) return false;
    const hash = crypto.createHmac("sha512", secret).update(body).digest("hex");
    return hash === header;
  }

  normaliseWebhookEvent(body: unknown): NormalisedPaymentData | null {
    const event = body as { event?: string; data?: Record<string, unknown> };
    if (event?.event !== "charge.success" || !event.data) return null;
    const d = event.data as Record<string, unknown>;
    return {
      reference: d.reference as string,
      amount: d.amount as number,
      status: d.status as string,
      metadata: (d.metadata ?? {}) as NormalisedPaymentData["metadata"],
      customer: d.customer as NormalisedPaymentData["customer"],
      currency: (d.currency as string) ?? "NGN",
      provider: "paystack",
      paidAt: d.paid_at as string | undefined,
      channel: d.channel as string | undefined,
      subaccountCode:
        typeof d.subaccount === "string"
          ? d.subaccount
          : ((d.subaccount as { subaccount_code?: string } | undefined)
              ?.subaccount_code),
      raw: d,
    };
  }
}
