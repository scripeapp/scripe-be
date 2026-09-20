import type { Database } from "../../db/database.types.js";
import { withDatabaseContext, type DatabaseContext } from "../../db/database-context.js";
import { DatabaseError, normalizeDatabaseError } from "../../db/errors.js";
import { withIdentity } from "../../db/principal.js";
import { AppError, notFoundError, validationError } from "../../shared/errors.js";
import { requirePermission } from "../authorization/authorization.service.js";
import * as repository from "./promotions.repository.js";
import type { RedemptionToRecord } from "./promotions.repository.js";
import type {
  AppliedDiscount,
  Discount,
  DiscountCreateInput,
  DiscountEvaluation,
  DiscountRow,
  DiscountUpdateInput,
  EvaluateInput,
  EvaluationItem,
  PromotionsOperation,
} from "./promotions.types.js";

// ============================================================================
// Pure evaluation logic — ported from legacy discount.service.ts, adapted to
// integer minor-unit arithmetic. Shared by the read-only preview endpoint and
// the checkout-time reservation path below.
// ============================================================================

function isAvailable(discount: DiscountRow, now: Date): boolean {
  if (!discount.isActive) return false;
  if (discount.maxUsage !== null && discount.usageCount >= discount.maxUsage) return false;
  if (discount.startsAt && discount.startsAt > now) return false;
  if (discount.expiresAt && discount.expiresAt <= now) return false;
  return true;
}

function cartSubtotalMinor(items: readonly EvaluationItem[]): bigint {
  return items.reduce((sum, item) => sum + BigInt(item.lineTotalMinor), 0n);
}

function eligibleSubtotalMinor(items: readonly EvaluationItem[], discount: DiscountRow): bigint {
  if (discount.appliesTo === "all") return cartSubtotalMinor(items);
  const eligible = new Set(discount.productIds);
  return items.filter((item) => eligible.has(item.productId)).reduce((sum, item) => sum + BigInt(item.lineTotalMinor), 0n);
}

function eligibleQuantity(items: readonly EvaluationItem[], qualificationProductIds: readonly string[]): number {
  const set = new Set(qualificationProductIds);
  return items
    .filter((item) => set.size === 0 || set.has(item.productId))
    .reduce((sum, item) => sum + item.quantity, 0);
}

function cartContainsQualificationProduct(items: readonly EvaluationItem[], qualificationProductIds: readonly string[]): boolean {
  if (qualificationProductIds.length === 0) return false;
  const set = new Set(qualificationProductIds);
  return items.some((item) => set.has(item.productId));
}

function calculateDiscountAmount(subtotalMinor: bigint, discount: DiscountRow): bigint {
  if (discount.type === "percentage") {
    return (subtotalMinor * BigInt(discount.percentageBps ?? 0)) / 10000n;
  }
  const fixed = BigInt(discount.fixedAmountMinor ?? "0");
  return fixed < subtotalMinor ? fixed : subtotalMinor;
}

function toApplied(discount: DiscountRow, amountMinor: bigint): AppliedDiscount {
  return { discountId: discount.id, kind: discount.kind, name: discount.name, code: discount.code, amountMinor: amountMinor.toString(), showOnStorefront: discount.showOnStorefront };
}

function calculateCandidate(discount: DiscountRow, items: readonly EvaluationItem[]): AppliedDiscount | null {
  const subtotal = eligibleSubtotalMinor(items, discount);
  if (subtotal <= 0n) return null;
  return toApplied(discount, calculateDiscountAmount(subtotal, discount));
}

function selectBest(candidates: readonly AppliedDiscount[]): AppliedDiscount | null {
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) => {
    const diff = BigInt(b.amountMinor) - BigInt(a.amountMinor);
    if (diff !== 0n) return diff > 0n ? 1 : -1;
    return a.discountId.localeCompare(b.discountId);
  })[0]!;
}

function qualifiesAutomatically(
  discount: DiscountRow,
  items: readonly EvaluationItem[],
  customerPartyId: string | null,
  isFirstOrder: boolean,
  customerRedemptions: ReadonlySet<string>,
): boolean {
  // A one-use-per-customer discount can't be safely offered to an unidentified customer.
  if (discount.oneUsePerCustomer && (!customerPartyId || customerRedemptions.has(discount.id))) return false;
  switch (discount.trigger) {
    case "spend_threshold":
      return cartSubtotalMinor(items) >= BigInt(discount.triggerSpendMinor ?? "0");
    case "quantity_bought":
      return eligibleQuantity(items, discount.qualificationProductIds) >= (discount.triggerQuantity ?? Number.POSITIVE_INFINITY);
    case "specific_products":
      return cartContainsQualificationProduct(items, discount.qualificationProductIds);
    case "first_order":
      return customerPartyId !== null && isFirstOrder;
    default:
      return false;
  }
}

interface EvaluationSources {
  readonly automaticCandidates: readonly DiscountRow[];
  readonly codeDiscount: DiscountRow | undefined;
  readonly customerRedemptions: ReadonlySet<string>;
  readonly isFirstOrder: boolean;
}

interface EvaluationResult {
  readonly applied: AppliedDiscount[];
  readonly automaticDiscount: AppliedDiscount | null;
  readonly codeDiscount: AppliedDiscount | null;
  readonly codeError?: string;
}

function computeEvaluation(items: readonly EvaluationItem[], customerPartyId: string | null, code: string | null, sources: EvaluationSources): EvaluationResult {
  const automaticCandidates = sources.automaticCandidates
    .filter((discount) => qualifiesAutomatically(discount, items, customerPartyId, sources.isFirstOrder, sources.customerRedemptions))
    .map((discount) => calculateCandidate(discount, items))
    .filter((candidate): candidate is AppliedDiscount => candidate !== null);
  const selectedAutomatic = selectBest(automaticCandidates);

  let selectedCode: AppliedDiscount | null = null;
  let codeError: string | undefined;

  if (code) {
    if (!sources.codeDiscount) {
      codeError = "Invalid discount code";
    } else if (!isAvailable(sources.codeDiscount, new Date())) {
      codeError = "Discount code is unavailable";
    } else if (sources.codeDiscount.oneUsePerCustomer && (!customerPartyId || sources.customerRedemptions.has(sources.codeDiscount.id))) {
      codeError = customerPartyId ? "You have already used this code" : "This code requires a known customer";
    } else {
      const candidate = calculateCandidate(sources.codeDiscount, items);
      codeError = candidate ? undefined : "No eligible items for this code";
      selectedCode = candidate;
    }

    if (selectedCode) {
      const automaticSource = sources.automaticCandidates.find((discount) => discount.id === selectedAutomatic?.discountId);
      const canStack = !selectedAutomatic || automaticSource?.allowCodeOnTop === true;
      if (!canStack) {
        codeError = "This automatic discount cannot be combined with a code";
        selectedCode = null;
      }
    }
  }

  const applied = [selectedAutomatic, selectedCode].filter((discount): discount is AppliedDiscount => discount !== null);
  return { applied, automaticDiscount: selectedAutomatic, codeDiscount: selectedCode, codeError };
}

// ============================================================================
// Checkout integration — called by carts.service.ts from within its own
// checkout transaction, so the row locks taken here (see
// listAvailableAutomaticDiscounts/findDiscountByCode with forUpdate=true)
// are held until that same transaction commits, safely serializing
// concurrent checkouts against the same discount's usage limit.
// ============================================================================

export interface ReservedDiscounts {
  readonly totalDiscountMinor: string;
  readonly redemptions: RedemptionToRecord[];
}

export async function reserveForCheckout(
  context: DatabaseContext,
  businessId: string,
  items: readonly EvaluationItem[],
  customerPartyId: string | null,
  code: string | null,
): Promise<ReservedDiscounts> {
  const automatics = await repository.listAvailableAutomaticDiscounts(context, businessId, true);
  const codeDiscount = code ? await repository.findDiscountByCode(context, businessId, code, true) : undefined;

  const relevantIds = [...automatics.map((discount) => discount.id), ...(codeDiscount ? [codeDiscount.id] : [])];
  const customerRedemptions = customerPartyId ? await repository.findCustomerRedemptions(context, businessId, customerPartyId, relevantIds) : new Set<string>();
  const needsFirstOrder = automatics.some((discount) => discount.trigger === "first_order");
  const isFirstOrder = customerPartyId && needsFirstOrder ? await repository.hasPriorOrder(context, businessId, customerPartyId) : false;

  const evaluation = computeEvaluation(items, customerPartyId, code, {
    automaticCandidates: automatics,
    codeDiscount,
    customerRedemptions,
    isFirstOrder,
  });

  // An explicitly requested code that fails should abort checkout rather than
  // silently proceed without it — the customer/staff asked for that discount.
  if (code && evaluation.codeError) throw validationError(evaluation.codeError);

  const subtotal = cartSubtotalMinor(items);
  const rawTotal = evaluation.applied.reduce((sum, discount) => sum + BigInt(discount.amountMinor), 0n);
  const totalDiscountMinor = rawTotal > subtotal ? subtotal : rawTotal;

  return {
    totalDiscountMinor: totalDiscountMinor.toString(),
    redemptions: evaluation.applied.map((discount) => ({ discountId: discount.discountId, amountMinor: discount.amountMinor })),
  };
}

// ============================================================================
// Service
// ============================================================================

export class PromotionsService {
  constructor(private readonly database: Database) {}

  async list(operation: PromotionsOperation): Promise<Discount[]> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.read");
      return (await repository.listDiscounts(context, operation.businessId)).map(toDiscount);
    });
  }

  async get(operation: PromotionsOperation, discountId: string): Promise<Discount> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.read");
      const row = await repository.findDiscount(context, operation.businessId, discountId);
      if (!row) throw notFoundError("Discount not found");
      return toDiscount(row);
    });
  }

  async create(operation: PromotionsOperation, input: DiscountCreateInput): Promise<Discount> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.manage");
      const created = await repository.createDiscount(context, operation.businessId, operation.userId, normalizeCode(input));
      return toDiscount(created);
    });
  }

  async update(operation: PromotionsOperation, discountId: string, input: DiscountUpdateInput): Promise<Discount> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.manage");
      const updated = await repository.updateDiscount(context, operation.businessId, discountId, normalizeCode(input));
      if (!updated) throw notFoundError("Discount not found");
      return toDiscount(updated);
    });
  }

  async archive(operation: PromotionsOperation, discountId: string): Promise<void> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.manage");
      if (!(await repository.archiveDiscount(context, operation.businessId, discountId))) throw notFoundError("Discount not found");
    });
  }

  async evaluate(operation: PromotionsOperation, input: EvaluateInput): Promise<DiscountEvaluation> {
    return this.run(operation, async (context) => {
      await requirePermission(context, operation.businessId, "promotion.read");
      const customerPartyId = input.customerPartyId ?? null;
      const code = input.code?.trim() || null;

      const automatics = await repository.listAvailableAutomaticDiscounts(context, operation.businessId, false);
      const codeDiscount = code ? await repository.findDiscountByCode(context, operation.businessId, code, false) : undefined;
      const relevantIds = [...automatics.map((discount) => discount.id), ...(codeDiscount ? [codeDiscount.id] : [])];
      const customerRedemptions = customerPartyId ? await repository.findCustomerRedemptions(context, operation.businessId, customerPartyId, relevantIds) : new Set<string>();
      const needsFirstOrder = automatics.some((discount) => discount.trigger === "first_order");
      const isFirstOrder = customerPartyId && needsFirstOrder ? await repository.hasPriorOrder(context, operation.businessId, customerPartyId) : false;

      const evaluation = computeEvaluation(input.items, customerPartyId, code, {
        automaticCandidates: automatics,
        codeDiscount,
        customerRedemptions,
        isFirstOrder,
      });

      const subtotal = cartSubtotalMinor(input.items);
      const rawTotal = evaluation.applied.reduce((sum, discount) => sum + BigInt(discount.amountMinor), 0n);
      const discountAmount = rawTotal > subtotal ? subtotal : rawTotal;

      return {
        automaticDiscount: evaluation.automaticDiscount,
        codeDiscount: evaluation.codeDiscount,
        discountAmountMinor: discountAmount.toString(),
        eligibleSubtotalMinor: subtotal.toString(),
        codeError: evaluation.codeError,
        requiresCustomerIdentity: !customerPartyId && needsFirstOrder,
      };
    });
  }

  private async run<T>(operation: PromotionsOperation, work: (context: DatabaseContext) => Promise<T>): Promise<T> {
    try {
      return await withDatabaseContext(this.database, withIdentity(operation.requestId, operation.userId, operation.businessId), work);
    } catch (error) {
      if (error instanceof AppError || error instanceof DatabaseError) throw error;
      throw normalizeDatabaseError(error);
    }
  }
}

function normalizeCode<T extends { code?: string | null }>(input: T): T {
  if (input.code === undefined || input.code === null) return input;
  return { ...input, code: input.code.trim().toUpperCase() };
}

function toDiscount(row: DiscountRow): Discount {
  return {
    ...row,
    startsAt: row.startsAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  };
}
