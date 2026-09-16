export const FEE_BEARER_VALUES = ["subaccount", "customer", "split"] as const;
export type FeeBearer = (typeof FEE_BEARER_VALUES)[number];

/**
 * Paystack subaccount settlement schedules.
 * - auto: payout is T+1
 * - weekly / monthly: payout on a fixed cadence
 * - manual: funds are held until the merchant requests a payout
 * Defaults to "auto" (Paystack's own default).
 */
export const SETTLEMENT_SCHEDULE_VALUES = [
  "auto",
  "weekly",
  "monthly",
  "manual",
] as const;
export type SettlementSchedule = (typeof SETTLEMENT_SCHEDULE_VALUES)[number];

export const DEFAULT_SETTLEMENT_SCHEDULE: SettlementSchedule = "auto";

export function isSettlementSchedule(
  value: unknown,
): value is SettlementSchedule {
  return SETTLEMENT_SCHEDULE_VALUES.includes(value as SettlementSchedule);
}
