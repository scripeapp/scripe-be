/**
 * Generic, forward-compatible event pricing engine (pure, no I/O).
 *
 * An event carries `pricing_rules`; each rule adjusts a seat's price when its
 * condition is met. The condition's `type` selects an evaluator from a registry,
 * so new condition types (location, date, …) are added by registering one
 * function — the pricing loop never changes. `segment_membership` and
 * `coupon_code` are wired.
 */

export type PricingTier = "standard" | "member" | "surcharged";

export interface PricingRuleCondition {
  type: string;
  [key: string]: unknown;
}

export interface PricingRuleAdjustment {
  type: "surcharge" | "discount";
  mode: "flat" | "percent";
  amount: number;
}

export interface PricingRule {
  id: string;
  active: boolean;
  condition: PricingRuleCondition;
  adjustment: PricingRuleAdjustment;
  applies_to: "per_attendee" | "per_order";
  redemption?: { cap: number } | null;
  message?: string;
}

export interface PricedTicket {
  id: string;
  ticket_price: number;
}

export interface PricingRecipient {
  ticketId: string;
  email?: string;
}

export interface SeatPricing {
  ticketId: string;
  attendeeEmail: string;
  basePrice: number;
  adjustment: number;
  tier: PricingTier;
  message: string | null;
  appliedDiscounts: Array<{
    ruleId: string;
    mode: "flat" | "percent";
    value: number;
    amount: number;
    couponCode?: string;
    message?: string;
  }>;
}

export interface AttendeePricingResult {
  baseTotal: number;
  adjustmentTotal: number;
  breakdown: SeatPricing[];
}

export function summarizePricingAdjustments(
  pricing: AttendeePricingResult,
): {
  discountTotal: number;
  surchargeTotal: number;
  discounts: SeatPricing["appliedDiscounts"];
} {
  const discountsByRule = new Map<
    string,
    SeatPricing["appliedDiscounts"][number]
  >();
  const totals = pricing.breakdown.reduce(
    (summary, seat) => {
      if (seat.adjustment < 0) {
        summary.discountTotal += Math.abs(seat.adjustment);
      } else if (seat.adjustment > 0) {
        summary.surchargeTotal += seat.adjustment;
      }
      for (const discount of seat.appliedDiscounts) {
        const existing = discountsByRule.get(discount.ruleId);
        discountsByRule.set(discount.ruleId, {
          ...discount,
          amount: (existing?.amount ?? 0) + discount.amount,
        });
      }
      return summary;
    },
    { discountTotal: 0, surchargeTotal: 0 },
  );
  return { ...totals, discounts: Array.from(discountsByRule.values()) };
}

export interface AttendeePricingInput {
  tickets: PricedTicket[];
  selectedTickets: Record<string, number>;
  buyerEmail: string;
  recipients?: PricingRecipient[];
  rules: PricingRule[];
  memberEmailsBySegment: Record<string, Set<string>>;
  priorRedemptionsByEmail?: Record<string, number>;
  couponCode?: string;
}

interface EvaluatorContext {
  attendeeEmail: string;
  memberEmailsBySegment: Record<string, Set<string>>;
  couponCode: string;
}

type ConditionEvaluator = (
  condition: PricingRuleCondition,
  context: EvaluatorContext,
) => boolean;

/**
 * Registry of condition evaluators, keyed by `condition.type`. Adding a new
 * rule type means registering one entry here — nothing else changes.
 */
const conditionEvaluators: Record<string, ConditionEvaluator> = {
  segment_membership: (condition, context) => {
    const segmentId = String(condition.segment_id);
    const members = context.memberEmailsBySegment[segmentId];
    const isMember = members?.has(context.attendeeEmail) ?? false;
    return condition.match === "in" ? isMember : !isMember;
  },
  coupon_code: (condition, context) => {
    const ruleCode = normaliseCouponCode(String(condition.code ?? ""));
    return ruleCode.length > 0 && ruleCode === context.couponCode;
  },
};

function normaliseCouponCode(code: string): string {
  return code.trim().toLowerCase();
}

/**
 * Condition types that price each seat by the attendee's own identity (their
 * email), so checkout must collect an email for every seat. Types absent here —
 * e.g. coupon codes, which match on a code — apply per seat without needing
 * distinct attendee emails.
 */
const IDENTITY_DEPENDENT_CONDITIONS = new Set(["segment_membership"]);

/**
 * Whether any active rule needs a separate email per seat. Coupon-only orders
 * don't, so buyers can apply a code to several tickets without listing attendees.
 */
export function rulesRequireAttendeeEmails(rules: PricingRule[]): boolean {
  return rules.some(
    (rule) =>
      rule.active &&
      rule.applies_to === "per_attendee" &&
      IDENTITY_DEPENDENT_CONDITIONS.has(rule.condition.type),
  );
}

/**
 * Whether the submitted code matches an active coupon rule, so the checkout can
 * tell the buyer their code was accepted without inferring it from price math.
 */
export function isCouponApplied(
  rules: PricingRule[],
  couponCode?: string,
): boolean {
  const submitted = normaliseCouponCode(couponCode ?? "");
  if (!submitted) return false;
  return rules.some(
    (rule) =>
      rule.active &&
      rule.condition.type === "coupon_code" &&
      normaliseCouponCode(String(rule.condition.code ?? "")) === submitted,
  );
}

export function computeAttendeePricing(
  input: AttendeePricingInput,
): AttendeePricingResult {
  const ticketPriceById = new Map(
    input.tickets.map((ticket) => [ticket.id, Number(ticket.ticket_price) || 0]),
  );
  const seats = expandSeats(
    input.selectedTickets,
    input.buyerEmail,
    input.recipients ?? [],
  );
  const activeRules = input.rules.filter((rule) => rule.active);
  const waivedCount = lowercaseCounts(input.priorRedemptionsByEmail ?? {});
  const couponCode = normaliseCouponCode(input.couponCode ?? "");

  const breakdown = seats.map((seat) =>
    priceSeat(seat, {
      basePrice: ticketPriceById.get(seat.ticketId) ?? 0,
      activeRules,
      memberEmailsBySegment: input.memberEmailsBySegment,
      waivedCount,
      couponCode,
    }),
  );

  return {
    baseTotal: sum(breakdown.map((seat) => seat.basePrice)),
    adjustmentTotal: sum(breakdown.map((seat) => seat.adjustment)),
    breakdown,
  };
}

interface SeatPricingContext {
  basePrice: number;
  activeRules: PricingRule[];
  memberEmailsBySegment: Record<string, Set<string>>;
  waivedCount: Record<string, number>;
  couponCode: string;
}

function priceSeat(
  seat: { ticketId: string; attendeeEmail: string },
  context: SeatPricingContext,
): SeatPricing {
  const email = seat.attendeeEmail.toLowerCase();
  let adjustment = 0;
  let tier: PricingTier = "standard";
  let message: string | null = null;
  const appliedDiscounts: SeatPricing["appliedDiscounts"] = [];

  for (const rule of context.activeRules) {
    if (rule.applies_to !== "per_attendee") continue;
    const evaluate = conditionEvaluators[rule.condition.type];
    if (!evaluate) continue;

    const triggered = evaluate(rule.condition, {
      attendeeEmail: email,
      memberEmailsBySegment: context.memberEmailsBySegment,
      couponCode: context.couponCode,
    });
    const outcome = resolveSeatRule({
      rule,
      triggered,
      basePrice: context.basePrice,
      email,
      waivedCount: context.waivedCount,
    });

    adjustment += outcome.adjustment;
    if (outcome.adjustment < 0) {
      appliedDiscounts.push({
        ruleId: rule.id,
        mode: rule.adjustment.mode,
        value: rule.adjustment.amount,
        amount: Math.abs(outcome.adjustment),
        couponCode:
          rule.condition.type === "coupon_code"
            ? String(rule.condition.code ?? "")
            : undefined,
        message: rule.message,
      });
    }
    if (outcome.tier !== "standard") tier = outcome.tier;
    if (outcome.message) message = outcome.message;
  }

  return {
    ticketId: seat.ticketId,
    attendeeEmail: seat.attendeeEmail,
    basePrice: context.basePrice,
    adjustment,
    tier,
    message,
    appliedDiscounts,
  };
}

/**
 * Decides a single rule's effect on a seat. For a surcharge rule, a triggered
 * condition (e.g. non-member) is charged; an untriggered one (member) is waived
 * up to the redemption cap, then charged like everyone else.
 */
function resolveSeatRule(params: {
  rule: PricingRule;
  triggered: boolean;
  basePrice: number;
  email: string;
  waivedCount: Record<string, number>;
}): { adjustment: number; tier: PricingTier; message: string | null } {
  const { rule, triggered, basePrice, email, waivedCount } = params;
  const charge = computeAdjustment(rule.adjustment, basePrice);
  const isSurcharge = rule.adjustment.type === "surcharge";

  if (triggered) {
    return {
      adjustment: charge,
      tier: isSurcharge ? "surcharged" : "standard",
      message: rule.message ?? null,
    };
  }

  if (!isSurcharge) {
    return { adjustment: 0, tier: "standard", message: null };
  }

  const cap = rule.redemption?.cap ?? Infinity;
  const used = waivedCount[email] ?? 0;
  if (used < cap) {
    waivedCount[email] = used + 1;
    return { adjustment: 0, tier: "member", message: null };
  }

  return { adjustment: charge, tier: "surcharged", message: rule.message ?? null };
}

function computeAdjustment(
  adjustment: PricingRuleAdjustment,
  basePrice: number,
): number {
  const magnitude =
    adjustment.mode === "percent"
      ? (basePrice * adjustment.amount) / 100
      : adjustment.amount;
  return adjustment.type === "discount" ? -magnitude : magnitude;
}

function expandSeats(
  selectedTickets: Record<string, number>,
  buyerEmail: string,
  recipients: PricingRecipient[],
): { ticketId: string; attendeeEmail: string }[] {
  const recipientEmailsByTicket: Record<string, string[]> = {};
  for (const recipient of recipients) {
    if (!recipient.ticketId) continue;
    (recipientEmailsByTicket[recipient.ticketId] ||= []).push(
      recipient.email || buyerEmail,
    );
  }

  const seats: { ticketId: string; attendeeEmail: string }[] = [];
  for (const [ticketId, quantity] of Object.entries(selectedTickets)) {
    const pending = [...(recipientEmailsByTicket[ticketId] ?? [])];
    for (let seat = 0; seat < quantity; seat++) {
      seats.push({ ticketId, attendeeEmail: pending.shift() ?? buyerEmail });
    }
  }
  return seats;
}

function lowercaseCounts(
  counts: Record<string, number>,
): Record<string, number> {
  const normalised: Record<string, number> = {};
  for (const [email, count] of Object.entries(counts)) {
    normalised[email.toLowerCase()] = count;
  }
  return normalised;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * Throws when a per-attendee rule is active but not every seat has an attendee
 * email. The buyer covers one seat; each additional seat needs a recipient email.
 */
export function assertAttendeeEmailsCoverSeats(
  selectedTickets: Record<string, number>,
  recipients: PricingRecipient[],
): void {
  const totalSeats = sum(Object.values(selectedTickets));
  const providedRecipientEmails = recipients.filter((recipient) =>
    isValidEmail(recipient.email),
  ).length;

  if (providedRecipientEmails < totalSeats - 1) {
    throw Object.assign(
      new Error("An attendee email is required for every ticket"),
      { statusCode: 400 },
    );
  }
}

function isValidEmail(email?: string): boolean {
  return !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
