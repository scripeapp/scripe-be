import type { FeeBearer } from "../../types/payment";
import type { PaymentMetadata } from "../../types/webhook";

export const SUPPORTED_CURRENCIES = [
  "NGN", // Nigerian Naira       — Paystack
  "GHS", // Ghanaian Cedi        — Flutterwave
  "KES", // Kenyan Shilling      — Flutterwave
  "ZAR", // South African Rand   — Flutterwave
  "USD", // US Dollar            — Flutterwave
  "GBP", // British Pound        — Flutterwave
  "TZS", // Tanzanian Shilling   — Flutterwave
  "UGX", // Ugandan Shilling     — Flutterwave
  "XAF", // Central African CFA  — Flutterwave
  "XOF", // West African CFA     — Flutterwave
  "RWF", // Rwandan Franc        — Flutterwave
  "ZMW", // Zambian Kwacha       — Flutterwave
] as const;

export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];
export type PaymentProviderName = "paystack" | "flutterwave";

// Provider-agnostic payment event — the canonical type for handleChargeSuccess.
export interface NormalisedPaymentData {
  reference: string;
  amount: number;
  /** Gateway's actual deduction, as reported on the charge (FLW app_fee). */
  gatewayFee?: number;
  status: string;
  metadata: PaymentMetadata;
  customer?: {
    name?: string;
    first_name?: string; // Paystack splits first/last; absent for FLW
    last_name?: string;
    email: string;
    phone?: string;
    customer_code?: string;
  };
  currency: string;
  provider: PaymentProviderName;
  paidAt?: string;
  // Present only for Paystack; lets the recovery flow detect dedicated_nuban
  // (virtual-account wallet deposits) that carry no order metadata.
  authorization?: {
    channel?: string;
    receiver_bank_account_number?: string;
  };
  channel?: string;
  subaccountCode?: string;
  providerSubaccountId?: string;
  raw?: Record<string, unknown>;
}

export interface InitPaymentParams {
  amount: number; // in naira / major currency unit (NOT kobo)
  email: string;
  currency: SupportedCurrency;
  reference?: string;
  metadata: PaymentMetadata;
  callbackUrl?: string;
  customerName?: string;
  // Paystack split-payment fields (ignored by Flutterwave)
  subaccountCode?: string;
  bearer?: FeeBearer;
  transactionCharge?: number; // in kobo — Hilaq's cut sent to main account
  planCode?: string;
  // Flutterwave split-payment fields (ignored by Paystack)
  // flwSubaccountId  — the RS_xxx ID returned when the FLW subaccount was created
  // flwMerchantAmount — major-unit amount the merchant subaccount receives
  //   (= baseAmount before platform fee; Hilaq's platformFee flows to main account)
  flwSubaccountId?: string;
  flwMerchantAmount?: number;
}

export interface CalculateFeesResult {
  totalToCharge: number;
  fee: number;
  platformFee: number;
}

// Transaction-scoped virtual account for a bank-transfer payment.
export interface VirtualAccount {
  bankName: string;
  accountName: string;
  accountNumber: string;
  expiresAt: string;
}

export interface BankTransferParams {
  amount: number; // major unit (naira)
  email: string;
  metadata: PaymentMetadata;
  reference?: string;
  subaccountCode?: string;
  bearer?: FeeBearer;
  transactionCharge?: number; // kobo — Hilaq's cut sent to main account
}

export interface BankTransferResult {
  reference: string;
  virtualAccount: VirtualAccount;
}

export interface IPaymentProvider {
  readonly name: PaymentProviderName;

  initializePayment(
    params: InitPaymentParams,
  ): Promise<{ authorization_url: string; reference: string }>;

  verifyPayment(reference: string): Promise<NormalisedPaymentData>;

  calculateFees(
    amountInMajorUnit: number,
    currency?: string,
  ): CalculateFeesResult;

  verifyWebhookSignature(body: string, header: string): boolean;

  normaliseWebhookEvent(body: unknown): NormalisedPaymentData | null;

  // Optional: only NGN/Paystack issues transaction-scoped virtual accounts.
  initiateBankTransfer?(params: BankTransferParams): Promise<BankTransferResult>;
}
