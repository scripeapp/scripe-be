import type { Selectable } from "kysely";
import type { Paylinks } from "../../db/database.types.codegen.js";

export type PaylinkRow = Selectable<Paylinks>;

export type PaylinkMode = "take_payment" | "product" | "donation";
export type PaylinkAmountType = "fixed" | "customer_sets";
export type PaylinkStatus = "active" | "paused" | "archived";

export interface PaylinkOperation {
  readonly businessId: string;
  readonly userId: string;
  readonly requestId: string;
}

export interface AnonymousOperation {
  readonly requestId: string;
}

export interface PaylinkSummary {
  readonly id: string;
  readonly businessId: string;
  readonly storeId: string;
  readonly channelId: string;
  readonly slug: string;
  readonly mode: PaylinkMode;
  readonly title: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly imageKey: string | null;
  readonly amountType: PaylinkAmountType;
  readonly amountMinor: string | null;
  readonly minAmountMinor: string | null;
  readonly suggestedAmountsMinor: string[];
  readonly currency: string;
  readonly productVariantId: string | null;
  readonly collectName: boolean;
  readonly collectPhone: boolean;
  readonly collectAddress: boolean;
  readonly redirectUrl: string | null;
  readonly status: PaylinkStatus;
  readonly expiresAt: string | null;
  readonly paymentCount: number;
  readonly totalCollectedMinor: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePaylinkInput {
  readonly title: string;
  readonly mode: PaylinkMode;
  readonly description?: string | null;
  readonly imageKey?: string | null;
  readonly amountType?: PaylinkAmountType;
  readonly amountMinor?: string | number | null;
  readonly minAmountMinor?: string | number | null;
  readonly suggestedAmountsMinor?: (string | number)[];
  readonly currency?: string;
  readonly productVariantId?: string | null;
  readonly customSlug?: string | null;
  readonly collectName?: boolean;
  readonly collectPhone?: boolean;
  readonly collectAddress?: boolean;
  readonly redirectUrl?: string | null;
  readonly expiresAt?: string | null;
  readonly storeId?: string | null;
  readonly status?: PaylinkStatus;
}

export interface UpdatePaylinkInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly imageKey?: string | null;
  readonly amountType?: PaylinkAmountType;
  readonly amountMinor?: string | number | null;
  readonly minAmountMinor?: string | number | null;
  readonly suggestedAmountsMinor?: (string | number)[];
  readonly collectName?: boolean;
  readonly collectPhone?: boolean;
  readonly collectAddress?: boolean;
  readonly redirectUrl?: string | null;
  readonly expiresAt?: string | null;
  readonly status?: "active" | "paused";
}

export interface PublicPaylinkProduct {
  readonly name: string;
  readonly sku?: string | null;
  readonly description?: string | null;
}

export interface PublicPaylink {
  readonly id: string;
  readonly slug: string;
  readonly mode: PaylinkMode;
  readonly title: string;
  readonly description: string | null;
  readonly imageUrl: string | null;
  readonly amountType: PaylinkAmountType;
  readonly amountMinor: string | null;
  readonly minAmountMinor: string | null;
  readonly suggestedAmountsMinor: string[];
  readonly currency: string;
  readonly collectName: boolean;
  readonly collectPhone: boolean;
  readonly collectAddress: boolean;
  readonly businessName: string;
  readonly businessLogoUrl: string | null;
  readonly product?: PublicPaylinkProduct | null;
}

export interface PublicCheckoutInput {
  readonly customerName: string;
  readonly customerEmail: string;
  readonly customerPhone?: string | null;
  readonly amountMinor?: string | number | null;
  readonly quantity?: number;
  readonly deliveryAddress?: {
    readonly streetAddress?: string;
    readonly city?: string;
    readonly state?: string;
  } | null;
  readonly idempotencyKey?: string | null;
}

export interface PublicCheckoutResult {
  readonly orderId: string;
  readonly paymentId: string;
  readonly reference: string;
  readonly authorizationUrl: string;
}

export interface PublicCheckoutStatus {
  readonly reference: string;
  readonly status: "pending" | "paid" | "failed";
  readonly amountMinor: string;
  readonly currency: string;
  readonly paidAt: string | null;
  readonly redirectUrl: string | null;
}

export interface PaylinkPaymentSummary {
  readonly id: string;
  readonly orderId: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly status: string;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly reference: string;
  readonly paidAt: string | null;
  readonly createdAt: string;
}
