import type { SupabaseClient } from "@supabase/supabase-js";
import {
  calculateDiscount,
  calculateEligibleSubtotal,
  type DiscountCode,
} from "../types/store";

export const DISCOUNT_COLUMNS = [
  "id",
  "store_id",
  "kind",
  "name",
  "code",
  "type",
  "value",
  "is_active",
  "usage_count",
  "max_usage",
  "one_use_per_customer",
  "starts_at",
  "expires_at",
  "applies_to",
  "product_ids",
  "trigger",
  "trigger_value",
  "qualification_product_ids",
  "allow_code_on_top",
  "show_on_storefront",
  "created_at",
  "updated_at",
].join(",");

export interface DiscountEvaluationItem {
  product_id: string;
  quantity: number;
  line_total: number;
}

export interface AppliedDiscount {
  id: string;
  kind: "code" | "automatic";
  name: string;
  code: string | null;
  amount: number;
  show_on_storefront: boolean;
}

export interface DiscountEvaluation {
  automatic_discount: AppliedDiscount | null;
  code_discount: AppliedDiscount | null;
  discounts: AppliedDiscount[];
  discount_amount: number;
  eligible_subtotal: number;
  total_after_discount: number;
  code_error?: string;
  requires_customer_identity: boolean;
}

export interface EvaluateDiscountsInput {
  storeId: string;
  items: DiscountEvaluationItem[];
  customerEmail?: string;
  code?: string;
  includeAutomatic?: boolean;
}

const hasReachedUsageLimit = (discount: DiscountCode): boolean =>
  discount.max_usage !== null &&
  discount.max_usage !== undefined &&
  discount.usage_count >= discount.max_usage;

export const isDiscountAvailable = (
  discount: DiscountCode,
  now = new Date(),
): boolean => {
  if (!discount.is_active || hasReachedUsageLimit(discount)) return false;
  if (discount.starts_at && new Date(discount.starts_at) > now) return false;
  if (discount.expires_at && new Date(discount.expires_at) <= now) return false;
  return true;
};

const cartSubtotal = (items: DiscountEvaluationItem[]): number =>
  items.reduce((total, item) => total + item.line_total, 0);

const eligibleSubtotal = (
  items: DiscountEvaluationItem[],
  discount: DiscountCode,
): number =>
  calculateEligibleSubtotal(
    items.map((item) => ({
      product_id: item.product_id,
      lineTotal: item.line_total,
    })),
    discount,
  );

const eligibleQuantity = (
  items: DiscountEvaluationItem[],
  qualificationProductIds: string[],
): number =>
  items
    .filter(
      (item) =>
        qualificationProductIds.length === 0 ||
        qualificationProductIds.includes(item.product_id),
    )
    .reduce((total, item) => total + item.quantity, 0);

const cartContainsQualificationProduct = (
  items: DiscountEvaluationItem[],
  qualificationProductIds: string[],
): boolean =>
  qualificationProductIds.length > 0 &&
  items.some((item) => qualificationProductIds.includes(item.product_id));

const toAppliedDiscount = (
  discount: DiscountCode,
  amount: number,
): AppliedDiscount => ({
  id: discount.id!,
  kind: discount.kind,
  name: discount.name || discount.code || "Discount",
  code: discount.code ?? null,
  amount,
  show_on_storefront: discount.show_on_storefront,
});

const calculateCandidate = (
  discount: DiscountCode,
  items: DiscountEvaluationItem[],
): AppliedDiscount | null => {
  const subtotal = eligibleSubtotal(items, discount);
  if (subtotal <= 0) return null;

  return toAppliedDiscount(
    discount,
    calculateDiscount(subtotal, discount.type, discount.value),
  );
};

const selectBestDiscount = (
  candidates: AppliedDiscount[],
): AppliedDiscount | null =>
  candidates.sort(
    (left, right) =>
      right.amount - left.amount || left.id.localeCompare(right.id),
  )[0] ?? null;

export class DiscountService {
  constructor(private readonly supabase: SupabaseClient) {}

  async evaluate(input: EvaluateDiscountsInput): Promise<DiscountEvaluation> {
    const subtotal = cartSubtotal(input.items);
    const normalizedEmail = input.customerEmail?.trim().toLowerCase();
    const includeAutomatic = input.includeAutomatic !== false;
    const automaticDiscounts = includeAutomatic
      ? await this.getAutomaticDiscounts(input.storeId)
      : [];
    const codeDiscount = input.code
      ? await this.getCodeDiscount(input.storeId, input.code)
      : null;
    const customerRedemptions = normalizedEmail
      ? await this.getCustomerRedemptions(
          input.storeId,
          normalizedEmail,
          [...automaticDiscounts, ...(codeDiscount ? [codeDiscount] : [])],
        )
      : new Set<string>();
    const needsFirstOrderCheck = automaticDiscounts.some(
      (discount) => discount.trigger === "first_order",
    );
    const isFirstOrder = normalizedEmail && needsFirstOrderCheck
      ? await this.isFirstOrder(input.storeId, normalizedEmail)
      : false;

    const automaticCandidates = automaticDiscounts
      .filter((discount) =>
        this.qualifiesAutomatically(
          discount,
          input.items,
          normalizedEmail,
          isFirstOrder,
          customerRedemptions,
        ),
      )
      .map((discount) => calculateCandidate(discount, input.items))
      .filter((discount): discount is AppliedDiscount => discount !== null);

    const selectedAutomatic = selectBestDiscount(automaticCandidates);
    const codeResult = input.code
      ? this.evaluateCode(codeDiscount, input.items, customerRedemptions)
      : { discount: null };
    const canStackCode =
      !selectedAutomatic ||
      automaticDiscounts.find(
        (discount) => discount.id === selectedAutomatic.id,
      )?.allow_code_on_top === true;
    const selectedCode = canStackCode ? codeResult.discount : null;
    const codeError =
      codeResult.error ||
      (codeResult.discount && !canStackCode
        ? "This automatic discount cannot be combined with a code"
        : undefined);
    const discounts = [selectedAutomatic, selectedCode].filter(
      (discount): discount is AppliedDiscount => discount !== null,
    );
    const discountAmount = Math.min(
      subtotal,
      discounts.reduce((total, discount) => total + discount.amount, 0),
    );

    return {
      automatic_discount: selectedAutomatic,
      code_discount: selectedCode,
      discounts,
      discount_amount: discountAmount,
      eligible_subtotal: subtotal,
      total_after_discount: Math.max(0, subtotal - discountAmount),
      code_error: codeError,
      requires_customer_identity:
        !normalizedEmail &&
        automaticDiscounts.some(
          (discount) => discount.trigger === "first_order",
        ),
    };
  }

  private async getAutomaticDiscounts(storeId: string): Promise<DiscountCode[]> {
    const { data, error } = await this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS)
      .eq("store_id", storeId)
      .eq("kind", "automatic")
      .eq("is_active", true)
      .limit(50);

    if (error) throw error;
    return ((data ?? []) as unknown as DiscountCode[]).filter((discount) =>
      isDiscountAvailable(discount),
    );
  }

  private async getCodeDiscount(
    storeId: string,
    code: string,
  ): Promise<DiscountCode | null> {
    const { data, error } = await this.supabase
      .from("discount_codes")
      .select(DISCOUNT_COLUMNS)
      .eq("store_id", storeId)
      .eq("kind", "code")
      .ilike("code", code.trim())
      .maybeSingle();

    if (error) throw error;
    return (data as unknown as DiscountCode | null) ?? null;
  }

  private async getCustomerRedemptions(
    storeId: string,
    customerEmail: string,
    discounts: DiscountCode[],
  ): Promise<Set<string>> {
    const limitedDiscountIds = discounts
      .filter((discount) => discount.one_use_per_customer)
      .map((discount) => discount.id)
      .filter((id): id is string => Boolean(id));
    if (limitedDiscountIds.length === 0) return new Set();

    const { data, error } = await this.supabase
      .from("discount_redemptions")
      .select("discount_id")
      .eq("store_id", storeId)
      .ilike("customer_email", customerEmail)
      .in("discount_id", limitedDiscountIds);

    if (error) throw error;
    return new Set((data ?? []).map((row) => row.discount_id as string));
  }

  private async isFirstOrder(
    storeId: string,
    customerEmail: string,
  ): Promise<boolean> {
    const { count, error } = await this.supabase
      .from("store_orders")
      .select("id", { count: "exact", head: true })
      .eq("store_id", storeId)
      .ilike("customer_email", customerEmail)
      .in("status", ["paid", "processing", "fulfilled"]);

    if (error) throw error;
    return (count ?? 0) === 0;
  }

  private qualifiesAutomatically(
    discount: DiscountCode,
    items: DiscountEvaluationItem[],
    customerEmail: string | undefined,
    isFirstOrder: boolean,
    customerRedemptions: Set<string>,
  ): boolean {
    if (!discount.id || customerRedemptions.has(discount.id)) return false;

    switch (discount.trigger) {
      case "spend_threshold":
        return cartSubtotal(items) >= (discount.trigger_value ?? Infinity);
      case "quantity_bought":
        return (
          eligibleQuantity(items, discount.qualification_product_ids) >=
          (discount.trigger_value ?? Infinity)
        );
      case "specific_products":
        return cartContainsQualificationProduct(
          items,
          discount.qualification_product_ids,
        );
      case "first_order":
        return Boolean(customerEmail) && isFirstOrder;
      default:
        return false;
    }
  }

  private evaluateCode(
    discount: DiscountCode | null,
    items: DiscountEvaluationItem[],
    customerRedemptions: Set<string>,
  ): { discount: AppliedDiscount | null; error?: string } {
    if (!discount) return { discount: null, error: "Invalid discount code" };
    if (!isDiscountAvailable(discount)) {
      return { discount: null, error: "Discount code is unavailable" };
    }
    if (discount.id && customerRedemptions.has(discount.id)) {
      return { discount: null, error: "You have already used this code" };
    }

    const appliedDiscount = calculateCandidate(discount, items);
    return appliedDiscount
      ? { discount: appliedDiscount }
      : { discount: null, error: "No eligible items for this code" };
  }
}
