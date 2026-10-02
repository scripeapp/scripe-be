import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { getPaystackGateway } from "../../integrations/checkout-gateway.js";
import { loadEnvironment } from "../../shared/environment.js";
import { conflictError } from "../../shared/errors.js";

interface SettlementTarget {
  readonly businessName: string;
  readonly virtualAccountId: string | null;
  readonly bankName: string | null;
  readonly bankSlug: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  readonly subaccountCode: string | null;
}

export interface CheckoutSettlementStatus {
  /** The Paystack subaccount sales settle to, once one exists for the current business account. */
  readonly subaccountCode: string | null;
  readonly businessName: string;
  readonly bankName: string | null;
  readonly accountNumber: string | null;
  readonly accountName: string | null;
  /** The business has an active virtual account, so a subaccount can be (or has been) set up. */
  readonly hasSettlementAccount: boolean;
}

async function loadTarget(context: DatabaseContext, businessId: string): Promise<SettlementTarget | undefined> {
  const result = await sql<SettlementTarget>`select * from app.get_checkout_settlement_target(${businessId}::uuid)`.execute(context.transaction);
  return result.rows[0];
}

/** Real Paystack is configured, so a sale without a subaccount would land in Scripe's balance instead of the business's. */
export function checkoutRequiresSubaccount(): boolean {
  return Boolean(loadEnvironment().PAYSTACK_SECRET_KEY);
}

/** Where this business's online sales settle today, without creating anything. */
export async function getCheckoutSettlementStatus(context: DatabaseContext, businessId: string): Promise<CheckoutSettlementStatus> {
  const target = await loadTarget(context, businessId);
  return {
    subaccountCode: target?.subaccountCode ?? null,
    businessName: target?.businessName ?? "",
    bankName: target?.bankName ?? null,
    accountNumber: target?.accountNumber ?? null,
    accountName: target?.accountName ?? null,
    hasSettlementAccount: Boolean(target?.virtualAccountId && target.accountNumber),
  };
}

/**
 * The Paystack subaccount a business's sale must settle to, creating it the
 * first time (or again after the business account changed). Settlement goes
 * to the business's own active virtual account. Returns null when the
 * business has no active virtual account yet, or when Paystack refused to
 * create the subaccount (logged). Safe for anonymous callers: everything
 * goes through SECURITY DEFINER functions scoped to `businessId`.
 */
export async function resolveCheckoutSubaccount(context: DatabaseContext, businessId: string): Promise<string | null> {
  const target = await loadTarget(context, businessId);
  if (!target?.virtualAccountId || !target.accountNumber) return null;
  if (target.subaccountCode) return target.subaccountCode;

  const environment = loadEnvironment();
  if (!environment.PAYSTACK_SECRET_KEY && !environment.PAYSTACK_MOCK_CHECKOUT) return null;

  // The provider call and the insert run under a savepoint so a failure
  // here never aborts the caller's checkout transaction.
  await sql`savepoint checkout_subaccount`.execute(context.transaction);
  try {
    const created = await getPaystackGateway().createSubaccount({
      businessName: target.accountName || target.businessName,
      bankName: target.bankName,
      bankSlug: target.bankSlug,
      accountNumber: target.accountNumber,
    });
    await sql`
      select app.save_checkout_subaccount(
        ${businessId}::uuid, ${target.virtualAccountId}::uuid, ${created.subaccountCode},
        ${created.bankCode}, ${target.accountNumber}, ${target.accountName}
      )
    `.execute(context.transaction);
    await sql`release savepoint checkout_subaccount`.execute(context.transaction);
    return created.subaccountCode;
  } catch (error) {
    await sql`rollback to savepoint checkout_subaccount`.execute(context.transaction);
    console.error(`[settlement] could not set up a Paystack subaccount for business ${businessId}:`, error);
    return null;
  }
}

/**
 * resolveCheckoutSubaccount for a merchant sale: with real Paystack
 * configured, a business that can't be settled to is refused rather than
 * silently paid into Scripe's balance. In development (mock or no
 * Paystack) it returns undefined and the checkout proceeds unsplit.
 */
export async function requireCheckoutSubaccount(context: DatabaseContext, businessId: string): Promise<string | undefined> {
  const code = await resolveCheckoutSubaccount(context, businessId);
  if (code) return code;
  if (checkoutRequiresSubaccount()) {
    throw conflictError("This business hasn't finished payout setup, so it can't take online payments yet.");
  }
  return undefined;
}
