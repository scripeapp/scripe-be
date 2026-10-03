import { sql } from "kysely";
import type { DatabaseContext } from "../../db/database-context.js";
import { emailSender, escapeHtml } from "../../shared/email.js";
import { loadEnvironment } from "../../shared/environment.js";
import * as notificationsRepo from "../notifications/notifications.repository.js";
import { absoluteBrandingImageUrl, loadBusinessBranding } from "../businesses/businesses.branding.js";
import * as repository from "./invoices.repository.js";
import type { ReportedTransfer } from "./invoices.repository.js";

/** Minor units → "₦12,550.00" (or the invoice's own currency), without going through a float for the integer part. */
export function formatMinor(minor: string | number | bigint, currency: string): string {
  const value = BigInt(minor);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (abs % 100n).toString().padStart(2, "0");
  const symbol = currency === "NGN" ? "₦" : `${currency} `;
  return `${negative ? "-" : ""}${symbol}${whole}.${cents}`;
}

/** Logo (absolute URL) and brand colour for a business's invoice emails; empty when it has none. */
export async function invoiceEmailBranding(context: DatabaseContext, businessId: string): Promise<{ logoUrl: string | null; brandColor: string | null }> {
  const branding = await loadBusinessBranding(context, businessId);
  return { logoUrl: absoluteBrandingImageUrl(branding?.logoUrl ?? null), brandColor: branding?.brandColor ?? null };
}

export function publicInvoiceUrl(token: string): string {
  return `${loadEnvironment().FRONTEND_URL || "https://scripe.app"}/i/${token}`;
}

function dashboardInvoiceUrl(invoiceId: string): string {
  return `${loadEnvironment().FRONTEND_URL || "https://scripe.app"}/dashboard/payments/invoices?invoiceId=${invoiceId}`;
}

/**
 * Runs `work` under a savepoint so a failed lookup or insert never aborts
 * the caller's transaction (a capture, a recorded payment). Emails are best
 * effort for the same reason: a failed send never undoes a payment.
 */
async function bestEffort(context: DatabaseContext, label: string, work: () => Promise<void>): Promise<void> {
  await sql`savepoint invoice_notification`.execute(context.transaction);
  try {
    await work();
    await sql`release savepoint invoice_notification`.execute(context.transaction);
  } catch (error) {
    await sql`rollback to savepoint invoice_notification`.execute(context.transaction);
    console.warn(`[invoices] ${label} failed:`, error);
  }
}

async function sendQuietly(label: string, send: () => Promise<void>): Promise<void> {
  try {
    await send();
  } catch (error) {
    console.warn(`[invoices] ${label} email failed:`, error);
  }
}

/**
 * "Payment received" for an invoice order: a receipt email to the customer,
 * and an email plus in-app notification to the business owner. Called after
 * a webhook capture (checkout-settlement.ts) and after a payment the
 * merchant records by hand. Does nothing when the order isn't an invoice.
 */
export async function notifyInvoicePayment(context: DatabaseContext, orderId: string, amountMinor: string): Promise<void> {
  let details: repository.InvoicePaymentNotification | undefined;
  await bestEffort(context, `payment notification for order ${orderId}`, async () => {
    details = await repository.getPaymentNotification(context, orderId);
    if (!details?.ownerUserId) return;
    const fullyPaid = BigInt(details.balanceDueMinor) === 0n;
    await notificationsRepo.createSystemNotification(context, {
      userId: details.ownerUserId,
      businessId: details.businessId,
      type: fullyPaid ? "invoice.paid" : "invoice.payment_received",
      title: fullyPaid
        ? `${details.invoiceNumber ?? "Invoice"} is paid`
        : `${formatMinor(amountMinor, details.currency)} received on ${details.invoiceNumber ?? "an invoice"}`,
      body: `${details.customerName ?? "A customer"} paid ${formatMinor(amountMinor, details.currency)}. Balance due: ${formatMinor(details.balanceDueMinor, details.currency)}.`,
      data: { invoiceId: details.invoiceId, orderId },
    });
  });
  if (!details) return;

  const found = details;
  const amount = formatMinor(amountMinor, found.currency);
  const balance = formatMinor(found.balanceDueMinor, found.currency);
  const number = found.invoiceNumber ?? "your invoice";
  const fullyPaid = BigInt(found.balanceDueMinor) === 0n;

  if (found.customerEmail) {
    await sendQuietly("customer receipt", () =>
      emailSender.sendTransactional({
        to: found.customerEmail!,
        subject: `Payment received: ${number} from ${found.businessName}`,
        html:
          `<p>Hello ${escapeHtml(found.customerName ?? "there")},</p>` +
          `<p><strong>${escapeHtml(found.businessName)}</strong> received your payment of <strong>${escapeHtml(amount)}</strong> for invoice <strong>${escapeHtml(number)}</strong>.</p>` +
          (fullyPaid
            ? `<p>This invoice is now paid in full. Thank you.</p>`
            : `<p>Balance still due: <strong>${escapeHtml(balance)}</strong>.</p>`) +
          `<p><a href="${escapeHtml(publicInvoiceUrl(found.publicToken))}">View invoice</a></p>`,
      }),
    );
  }

  if (found.merchantEmail && (await notificationsRepo.wantsEmail(context, found.merchantEmail, "sales"))) {
    await sendQuietly("merchant payment", () =>
      emailSender.sendTransactional({
        to: found.merchantEmail!,
        subject: fullyPaid ? `${number} is paid (${amount})` : `${amount} received on ${number}`,
        html:
          `<p><strong>${escapeHtml(found.customerName ?? "A customer")}</strong> paid <strong>${escapeHtml(amount)}</strong> on invoice <strong>${escapeHtml(number)}</strong>.</p>` +
          `<p>${fullyPaid ? "The invoice is paid in full." : `Balance still due: <strong>${escapeHtml(balance)}</strong>.`}</p>` +
          `<p><a href="${escapeHtml(dashboardInvoiceUrl(found.invoiceId))}">Open the invoice</a></p>`,
      }),
    );
  }
}

/** Tells the business owner (in-app + email) that a customer says they paid by transfer, so they check their account and record it. */
export async function notifyTransferReported(context: DatabaseContext, report: ReportedTransfer): Promise<void> {
  const amount = formatMinor(report.balanceDueMinor, report.currency);
  const number = report.invoiceNumber ?? "an invoice";
  const customer = report.customerName ?? "Your customer";

  if (report.ownerUserId) {
    await bestEffort(context, `transfer notification for invoice ${report.invoiceId}`, async () => {
      await notificationsRepo.createSystemNotification(context, {
        userId: report.ownerUserId!,
        businessId: report.businessId,
        type: "invoice.transfer_reported",
        title: `${customer} says they paid ${number} by transfer`,
        body: `Check your business account for ${amount}, then record the payment on the invoice.`,
        data: { invoiceId: report.invoiceId },
      });
    });
  }

  if (report.merchantEmail && (await notificationsRepo.wantsEmail(context, report.merchantEmail, "sales"))) {
    await sendQuietly("merchant transfer report", () =>
      emailSender.sendTransactional({
        to: report.merchantEmail!,
        subject: `${customer} says they paid ${number} by transfer`,
        html:
          `<p><strong>${escapeHtml(customer)}</strong> reported a bank transfer of <strong>${escapeHtml(amount)}</strong> for invoice <strong>${escapeHtml(number)}</strong>.</p>` +
          `<p>Nothing is marked paid yet. Check your business account, then record the payment on the invoice.</p>` +
          `<p><a href="${escapeHtml(dashboardInvoiceUrl(report.invoiceId))}">Open the invoice</a></p>`,
      }),
    );
  }
}
