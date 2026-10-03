import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { emailSender, escapeHtml } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import { LEDGER_ACCOUNT_CODES } from "../accounting/accounting.types.js";
import type { JournalLineInput } from "../accounting/accounting.types.js";
import { postJournalEntry } from "../accounting/accounting.service.js";
import { notifyInvoicePayment } from "../invoices/invoices.notifications.js";
import * as notificationsRepository from "../notifications/notifications.repository.js";
import * as repository from "./provider-events.repository.js";
import type { CaptureResult } from "./provider-events.repository.js";

/** What the gateway says it actually charged, in minor units. */
export interface ObservedCharge {
  readonly amountMinor: string | null;
  readonly currency: string | null;
}

export type SettlementOutcome =
  | { readonly status: "not_found" }
  | { readonly status: "captured" | "already_settled"; readonly result: CaptureResult };

export class ChargeMismatchError extends Error {}

/**
 * The one path every confirmed checkout charge goes through — the Paystack
 * and Flutterwave webhooks and the paylink status check alike — so the
 * amount check, ledger posting, receipt and notifications cannot drift
 * apart between them.
 *
 * The charged amount must be at least the payment's amount (a merchant who
 * passes gateway fees to the customer is charged more than requested) and
 * in the same currency; anything else throws ChargeMismatchError and
 * captures nothing.
 */
export async function settleCheckoutPayment(context: DatabaseContext, reference: string, observed: ObservedCharge): Promise<SettlementOutcome> {
  const expected = await repository.findCheckoutPaymentByReference(context, reference);
  if (!expected) return { status: "not_found" };

  if (!chargeCovers(expected, observed)) {
    throw new ChargeMismatchError(
      `Charge ${observed.amountMinor ?? "?"} ${observed.currency ?? "?"} does not cover payment ${expected.amountMinor} ${expected.assetCode}`,
    );
  }

  const result = await repository.captureCheckoutPaymentByReference(context, reference);
  if (!result.captured) return { status: "already_settled", result };

  await postCaptureJournal(context, reference, result);
  if (result.isFullyPaid && result.businessId && result.orderId) {
    await repository.issueReceiptFromWebhook(context, result.businessId, result.orderId);
  }
  if (expected.paylinkId) await notifyPaylinkPayment(context, reference);
  // No-op unless the order is an invoice; runs under its own savepoint.
  if (result.orderId && result.amountMinor) await notifyInvoicePayment(context, result.orderId, String(result.amountMinor));
  return { status: "captured", result };
}

function chargeCovers(expected: { amountMinor: string; assetCode: string }, observed: ObservedCharge): boolean {
  if (!observed.amountMinor || !/^\d+$/.test(observed.amountMinor) || !observed.currency) return false;
  return BigInt(observed.amountMinor) >= BigInt(expected.amountMinor) && observed.currency.toUpperCase() === expected.assetCode.toUpperCase();
}

/**
 * A payment reaching "captured" without a cashier: debits gateway clearing
 * (cash never arrives by webhook), credits revenue and prorated tax, the
 * rounding remainder folding into revenue so the entry balances exactly.
 */
export async function postCaptureJournal(context: DatabaseContext, reference: string, result: CaptureResult): Promise<void> {
  if (!result.businessId || !result.amountMinor || !result.assetCode) return;
  const amountMinor = BigInt(result.amountMinor);
  const totalMinor = BigInt(result.orderTotalMinor ?? "0");
  const taxMinor = BigInt(result.orderTaxMinor ?? "0");
  const taxPortion = totalMinor > 0n ? (amountMinor * taxMinor) / totalMinor : 0n;
  const revenuePortion = amountMinor - taxPortion;

  const lines: JournalLineInput[] = [{ accountCode: LEDGER_ACCOUNT_CODES.GATEWAY_CLEARING, direction: "debit", amountMinor, assetCode: result.assetCode }];
  if (revenuePortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.REVENUE, direction: "credit" as const, amountMinor: revenuePortion, assetCode: result.assetCode });
  if (taxPortion > 0n) lines.push({ accountCode: LEDGER_ACCOUNT_CODES.TAX_PAYABLE, direction: "credit" as const, amountMinor: taxPortion, assetCode: result.assetCode });

  await postJournalEntry(context, result.businessId, null, {
    description: "Payment captured via webhook",
    sourceType: "payment_capture",
    sourceId: reference,
    lines,
  });
}

interface PaylinkPaymentNotification {
  readonly orderNumber: string;
  readonly amountMinor: string;
  readonly currency: string;
  readonly paylinkTitle: string;
  readonly businessName: string;
  readonly merchantEmail: string | null;
  readonly customerName: string | null;
  readonly customerEmail: string | null;
  readonly businessId: string;
  readonly paylinkId: string;
  readonly orderId: string;
  readonly ownerUserId: string | null;
}

function formatMoney(amountMinor: string, currency: string): string {
  const major = (Number(amountMinor) / 100).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "NGN" ? `₦${major}` : `${currency} ${major}`;
}

/**
 * Customer receipt + merchant "you got paid" emails for a captured paylink
 * payment. Best effort: a failed email never undoes a capture.
 */
async function notifyPaylinkPayment(context: DatabaseContext, reference: string): Promise<void> {
  let details: PaylinkPaymentNotification | undefined;
  // A failed statement aborts the surrounding transaction even when caught,
  // so the lookup runs under its own savepoint to keep the capture intact.
  await sql`savepoint paylink_notification`.execute(context.transaction);
  try {
    const rows = await sql<PaylinkPaymentNotification>`select * from app.get_paylink_payment_notification(${reference})`.execute(context.transaction);
    details = rows.rows[0];
    await sql`release savepoint paylink_notification`.execute(context.transaction);
  } catch (error) {
    await sql`rollback to savepoint paylink_notification`.execute(context.transaction);
    console.warn(`[paylinks] could not load notification details for ${reference}:`, error);
    return;
  }
  if (!details) return;

  const amount = formatMoney(String(details.amountMinor), details.currency);
  const title = escapeHtml(details.paylinkTitle);

  // In-app alert for the business owner (same recipient as invoices), under
  // its own savepoint so a failed insert never undoes the capture.
  if (details.ownerUserId) {
    await sql`savepoint paylink_in_app_notification`.execute(context.transaction);
    try {
      await notificationsRepository.createSystemNotification(context, {
        userId: details.ownerUserId,
        businessId: details.businessId,
        type: "paylink.payment_received",
        title: `${amount} received via ${details.paylinkTitle}`,
        body: `${details.customerName ?? "A customer"} paid ${amount}. Order ${details.orderNumber}.`,
        data: { paylinkId: details.paylinkId, orderId: details.orderId, reference },
      });
      await sql`release savepoint paylink_in_app_notification`.execute(context.transaction);
    } catch (error) {
      await sql`rollback to savepoint paylink_in_app_notification`.execute(context.transaction);
      console.warn(`[paylinks] in-app notification failed for ${reference}:`, error);
    }
  }
  const business = escapeHtml(details.businessName);

  if (details.customerEmail) {
    try {
      await emailSender.sendTransactional({
        to: details.customerEmail,
        subject: `Receipt from ${details.businessName}: ${amount}`,
        html:
          `<p>Hello ${escapeHtml(details.customerName ?? "there")},</p>` +
          `<p>Your payment of <strong>${escapeHtml(amount)}</strong> to <strong>${business}</strong> for <strong>${title}</strong> was successful.</p>` +
          `<p>Order: ${escapeHtml(details.orderNumber)}<br/>Reference: ${escapeHtml(reference)}</p>` +
          `<p>Keep this email as your receipt.</p>`,
      });
    } catch (error) {
      console.warn(`[paylinks] customer receipt email failed for ${reference}:`, error);
    }
  }

  if (details.merchantEmail && (await notificationsRepository.wantsEmail(context, details.merchantEmail, "sales"))) {
    try {
      const dashboardUrl = `${loadEnvironment().FRONTEND_URL}/dashboard/payments/paylinks`;
      await emailSender.sendTransactional({
        to: details.merchantEmail,
        subject: `You received ${amount} via "${details.paylinkTitle}"`,
        html:
          `<p><strong>${escapeHtml(details.customerName ?? "A customer")}</strong>${details.customerEmail ? ` (${escapeHtml(details.customerEmail)})` : ""} paid <strong>${escapeHtml(amount)}</strong> through your payment link <strong>${title}</strong>.</p>` +
          `<p>Order: ${escapeHtml(details.orderNumber)}<br/>Reference: ${escapeHtml(reference)}</p>` +
          `<p><a href="${escapeHtml(dashboardUrl)}">View payment links</a></p>`,
      });
    } catch (error) {
      console.warn(`[paylinks] merchant notification email failed for ${reference}:`, error);
    }
  }
}
