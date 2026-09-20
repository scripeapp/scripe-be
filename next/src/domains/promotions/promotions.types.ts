export type DiscountKind = "code" | "automatic";
export type DiscountType = "percentage" | "fixed";
export type DiscountTrigger = "spend_threshold" | "quantity_bought" | "specific_products" | "first_order";

export interface DiscountRow {
  readonly id: string;
  readonly businessId: string;
  readonly kind: DiscountKind;
  readonly name: string;
  readonly code: string | null;
  readonly type: DiscountType;
  readonly percentageBps: number | null;
  readonly fixedAmountMinor: string | null;
  readonly isActive: boolean;
  readonly maxUsage: number | null;
  readonly usageCount: number;
  readonly oneUsePerCustomer: boolean;
  readonly startsAt: Date | null;
  readonly expiresAt: Date | null;
  readonly appliesTo: "all" | "specific_products";
  readonly productIds: string[];
  readonly trigger: DiscountTrigger | null;
  readonly triggerSpendMinor: string | null;
  readonly triggerQuantity: number | null;
  readonly qualificationProductIds: string[];
  readonly allowCodeOnTop: boolean;
  readonly showOnStorefront: boolean;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly archivedAt: Date | null;
}

export interface Discount extends Omit<DiscountRow, "startsAt" | "expiresAt" | "createdAt" | "updatedAt" | "archivedAt"> {
  readonly startsAt: string | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface PromotionsOperation {
  readonly userId: string;
  readonly businessId: string;
  readonly requestId: string;
}

export interface DiscountCreateInput {
  readonly kind: DiscountKind;
  readonly name: string;
  readonly code?: string | null;
  readonly type: DiscountType;
  readonly percentageBps?: number | null;
  readonly fixedAmountMinor?: string | null;
  readonly isActive?: boolean;
  readonly maxUsage?: number | null;
  readonly oneUsePerCustomer?: boolean;
  readonly startsAt?: string | null;
  readonly expiresAt?: string | null;
  readonly appliesTo?: "all" | "specific_products";
  readonly productIds?: string[];
  readonly trigger?: DiscountTrigger | null;
  readonly triggerSpendMinor?: string | null;
  readonly triggerQuantity?: number | null;
  readonly qualificationProductIds?: string[];
  readonly allowCodeOnTop?: boolean;
  readonly showOnStorefront?: boolean;
}

export type DiscountUpdateInput = Partial<Omit<DiscountCreateInput, "kind" | "type">>;

export interface EvaluationItem {
  readonly productId: string;
  readonly quantity: number;
  readonly lineTotalMinor: string;
}

export interface AppliedDiscount {
  readonly discountId: string;
  readonly kind: DiscountKind;
  readonly name: string;
  readonly code: string | null;
  readonly amountMinor: string;
  readonly showOnStorefront: boolean;
}

export interface DiscountEvaluation {
  readonly automaticDiscount: AppliedDiscount | null;
  readonly codeDiscount: AppliedDiscount | null;
  readonly discountAmountMinor: string;
  readonly eligibleSubtotalMinor: string;
  readonly codeError?: string;
  readonly requiresCustomerIdentity: boolean;
}

export interface EvaluateInput {
  readonly items: EvaluationItem[];
  readonly customerPartyId?: string | null;
  readonly code?: string | null;
}
