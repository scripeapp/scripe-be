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

export interface ListPaymentsFilter {
  readonly orderId?: string;
  readonly status?: "pending" | "authorized" | "captured" | "failed" | "cancelled" | "refunded";
  readonly method?: "cash" | "card" | "bank_transfer" | "online";
  readonly limit?: number;
  readonly offset?: number;
}

export interface PaymentRow {
  readonly id: string;
  readonly businessId: string;
  readonly orderId: string;
  readonly method: string;
  readonly status: string;
  readonly assetCode: string;
  readonly amountMinor: string;
  readonly externalReference: string | null;
  readonly idempotencyKey: string;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly orderNumber?: string | null;
  readonly customerName?: string | null;
  readonly customerEmail?: string | null;
  readonly orderTotalMinor?: string | null;
}
