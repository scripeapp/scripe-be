export interface PaymentOperation { readonly userId: string; readonly businessId: string; readonly requestId: string; }
export interface RecordPaymentInput { readonly orderId: string; readonly method: "cash"|"card"|"bank_transfer"|"online"; readonly assetCode: string; readonly amountMinor: number; readonly status?: "pending"|"authorized"|"captured"|"failed"|"cancelled"; readonly externalReference?: string | null; readonly idempotencyKey: string; }

export interface InitiateCheckoutInput {
  readonly orderId: string;
  readonly gateway: "paystack" | "flutterwave";
  readonly assetCode: string;
  readonly amountMinor: number;
  readonly email: string;
  readonly callbackUrl?: string;
  readonly idempotencyKey: string;
}

export interface InitiatedCheckout {
  readonly paymentId: string;
  readonly authorizationUrl: string;
  readonly reference: string;
}

export interface CheckoutStatus {
  readonly status: "pending" | "captured" | "failed";
  readonly isFullyPaid?: boolean;
}
