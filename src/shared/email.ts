import { loadEnvironment } from "./environment.js";

interface PlunkSendResponse {
  success: boolean;
  email?: string;
  message?: string;
}

interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  /** Overrides PLUNK_FROM_EMAIL — used by the communications domain to send as a business's own resolved sender. */
  readonly from?: string;
  /** Secret-free fragment included in the development log line. */
  readonly logHint: string;
}

/**
 * Sends transactional emails via Plunk (REST). In development/test without a
 * PLUNK_API_KEY the email is logged instead, so local flows still complete.
 * In production a missing key is a hard failure (validated at startup).
 */
/** Every interpolated value in an email body goes through this — business and director names are user-supplied, so an unescaped value is HTML injection into mail sent from our domain. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Business logo (or name) at the top of an invoice email. */
function invoiceEmailHeader(params: { businessName: string; logoUrl?: string | null }): string {
  const identity = params.logoUrl
    ? `<img src="${escapeHtml(params.logoUrl)}" alt="${escapeHtml(params.businessName)}" style="max-height:48px;max-width:200px;display:block" />`
    : `<h2 style="font-size:18px;font-weight:700;color:#111827;margin:0">${escapeHtml(params.businessName)}</h2>`;
  return `<div style="margin-bottom:20px;border-bottom:1px solid #e5e7eb;padding-bottom:12px">${identity}</div>`;
}

/** Only a validated #RRGGBB reaches a style attribute; anything else uses Scripe's default. */
function invoiceButtonColor(brandColor?: string | null): string {
  return brandColor && /^#[0-9A-Fa-f]{6}$/.test(brandColor) ? brandColor : "#FF5B1F";
}

export interface EmailSender {
  sendVerificationCode(to: string, code: string): Promise<void>;
  sendPasswordResetEmail(to: string, url: string): Promise<void>;
  sendBusinessInvitation(
    to: string,
    params: BusinessInvitationEmail,
  ): Promise<void>;
  /** Arbitrary subject/body send used by the communications domain, sent as a business's own resolved sender rather than the platform's fixed templates above. */
  sendTransactional(params: {
    to: string;
    subject: string;
    html: string;
    from?: string;
  }): Promise<void>;
  sendBankingKybSubmitted(
    to: string,
    params: BankingKybSubmittedEmail,
  ): Promise<void>;
  sendBankingKybApproved(
    to: string,
    params: BankingKybApprovedEmail,
  ): Promise<void>;
  sendBankingKybFailed(
    to: string,
    params: BankingKybFailedEmail,
  ): Promise<void>;
  sendVirtualAccountIssued(
    to: string,
    params: VirtualAccountIssuedEmail,
  ): Promise<void>;
  sendVirtualAccountDeposit(
    to: string,
    params: VirtualAccountDepositEmail,
  ): Promise<void>;
  sendInvoiceIssued(
    to: string,
    params: InvoiceIssuedEmail,
  ): Promise<void>;
  sendInvoiceReminder(
    to: string,
    params: InvoiceReminderEmail,
  ): Promise<void>;
  sendPurchaseOrder(to: string, params: PurchaseOrderEmail): Promise<void>;
}

export interface PurchaseOrderEmail {
  readonly businessName: string;
  readonly supplierName: string;
  readonly orderNumber: string;
  /** Already formatted for display, e.g. "3 Oct 2026". */
  readonly orderDate: string;
  readonly expectedDate?: string | null;
  readonly lines: readonly { name: string; quantity: string; unitCostFormatted: string; totalFormatted: string }[];
  readonly totalFormatted: string;
  readonly notes?: string | null;
  /** Where the supplier's reply should go — the business's own email, when known. */
  readonly replyToEmail?: string | null;
}

export interface InvoiceIssuedEmail {
  readonly businessName: string;
  /** Absolute URL of the business's logo; the header falls back to the business name. */
  readonly logoUrl?: string | null;
  /** The business's brand colour (#RRGGBB) for the pay button. */
  readonly brandColor?: string | null;
  readonly customerName: string;
  readonly invoiceNumber: string;
  readonly amountFormatted: string;
  readonly dueDate: string;
  readonly payUrl: string;
  readonly notes?: string | null;
}

export interface InvoiceReminderEmail {
  readonly businessName: string;
  /** Absolute URL of the business's logo; the header falls back to the business name. */
  readonly logoUrl?: string | null;
  /** The business's brand colour (#RRGGBB) for the pay button. */
  readonly brandColor?: string | null;
  readonly customerName: string;
  readonly invoiceNumber: string;
  readonly amountFormatted: string;
  readonly dueDate: string;
  readonly payUrl: string;
  readonly isOverdue?: boolean;
}

export interface BusinessInvitationEmail {
  readonly businessName: string;
  readonly inviterName: string;
  readonly acceptUrl: string;
}

export interface BankingKybSubmittedEmail {
  readonly businessName: string;
  readonly directorName: string;
  readonly dashboardUrl: string;
}

export interface BankingKybApprovedEmail {
  readonly businessName: string;
  readonly directorName: string;
  readonly dashboardUrl: string;
}

export interface BankingKybFailedEmail {
  readonly businessName: string;
  readonly directorName: string;
  readonly reason: string;
  readonly retryUrl: string;
}

export interface VirtualAccountIssuedEmail {
  readonly businessName: string;
  readonly accountNumber: string;
  readonly accountName: string;
  readonly bankName: string;
  readonly dashboardUrl: string;
}

export interface VirtualAccountDepositEmail {
  readonly businessName: string;
  readonly amountFormatted: string;
  readonly accountNumber: string;
  readonly bankName: string;
  readonly dashboardUrl: string;
}

export class PlunkEmailSender implements EmailSender {
  async sendVerificationCode(to: string, code: string): Promise<void> {
    await this.send({
      to,
      subject: "Your Scripe verification code",
      html:
        `<p>Enter this code to verify your email address:</p>` +
        `<p style="font-size:24px;font-weight:700;letter-spacing:6px">${escapeHtml(code)}</p>` +
        `<p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>`,
      logHint: `code=${code}`,
    });
  }

  async sendPasswordResetEmail(to: string, url: string): Promise<void> {
    await this.send({
      to,
      subject: "Reset your password",
      html: `<p>Reset your Scripe account password:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p>`,
      logHint: `link=${url}`,
    });
  }

  async sendBusinessInvitation(
    to: string,
    params: BusinessInvitationEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `You've been invited to join ${params.businessName} on Scripe`,
      html:
        `<p>${escapeHtml(params.inviterName)} invited you to join <strong>${escapeHtml(params.businessName)}</strong> on Scripe.</p>` +
        `<p><a href="${escapeHtml(params.acceptUrl)}">${escapeHtml(params.acceptUrl)}</a></p>` +
        `<p>This invitation expires in 7 days. If you weren't expecting this, ignore this email.</p>`,
      logHint: `link=${params.acceptUrl}`,
    });
  }

  async sendTransactional(params: {
    to: string;
    subject: string;
    html: string;
    from?: string;
  }): Promise<void> {
    await this.send({ ...params, logHint: "transactional" });
  }

  async sendBankingKybSubmitted(
    to: string,
    params: BankingKybSubmittedEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Your business verification is under review — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;margin-bottom:16px">We received your business verification</h2>` +
        `<p>Hello ${escapeHtml(params.directorName)},</p>` +
        `<p>Thank you for submitting verification details for <strong>${escapeHtml(params.businessName)}</strong>.</p>` +
        `<p>We are reviewing your business details and documents. This typically takes <strong>1 to 2 business days</strong>.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(params.dashboardUrl)}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View Verification Status</a></p>` +
        `<p style="color:#6b7280;font-size:13px">You will receive an email as soon as your dedicated corporate account is ready.</p>` +
        `</div>`,
      logHint: `kyb_submitted=${params.businessName}`,
    });
  }

  async sendBankingKybApproved(
    to: string,
    params: BankingKybApprovedEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Your business verification has been approved! — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#10b981;margin-bottom:16px">Verification Approved</h2>` +
        `<p>Hello ${escapeHtml(params.directorName)},</p>` +
        `<p>Great news! The business verification for <strong>${escapeHtml(params.businessName)}</strong> has been successfully approved.</p>` +
        `<p>Your business is now eligible to generate and use a dedicated corporate bank account to collect payments and bank transfers from customers.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(params.dashboardUrl)}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">Go to Banking Dashboard</a></p>` +
        `</div>`,
      logHint: `kyb_approved=${params.businessName}`,
    });
  }

  async sendBankingKybFailed(
    to: string,
    params: BankingKybFailedEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Action required: Update your business verification — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#ef4444;margin-bottom:16px">Verification Update Required</h2>` +
        `<p>Hello ${escapeHtml(params.directorName)},</p>` +
        `<p>We encountered an issue while verifying <strong>${escapeHtml(params.businessName)}</strong>:</p>` +
        `<div style="background-color:#fef2f2;border:1px solid #fecaca;padding:12px 16px;border-radius:6px;color:#991b1b;margin:16px 0;font-size:14px">${escapeHtml(params.reason)}</div>` +
        `<p>Please review and update your information so we can complete your verification and issue your account.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(params.retryUrl)}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">Update Details</a></p>` +
        `</div>`,
      logHint: `kyb_failed=${params.businessName}`,
    });
  }

  async sendVirtualAccountIssued(
    to: string,
    params: VirtualAccountIssuedEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Your dedicated corporate account is ready — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;margin-bottom:16px">Your Business Account is Ready</h2>` +
        `<p>Your dedicated corporate bank account for <strong>${escapeHtml(params.businessName)}</strong> is active and ready to receive funds:</p>` +
        `<div style="background-color:#f9fafb;border:1px solid #e5e7eb;padding:16px;border-radius:8px;margin:16px 0">` +
        `<div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px;display:block">BANK NAME</span><strong style="font-size:15px">${escapeHtml(params.bankName)}</strong></div>` +
        `<div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px;display:block">ACCOUNT NUMBER</span><strong style="font-size:18px;letter-spacing:1px">${escapeHtml(params.accountNumber)}</strong></div>` +
        `<div><span style="color:#6b7280;font-size:12px;display:block">ACCOUNT NAME</span><strong style="font-size:15px">${escapeHtml(params.accountName)}</strong></div>` +
        `</div>` +
        `<p style="color:#4b5563;font-size:14px">Any bank transfer sent to this account will be automatically credited to your Scripe business balance.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(params.dashboardUrl)}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View in Dashboard</a></p>` +
        `</div>`,
      logHint: `account_issued=${params.accountNumber}`,
    });
  }

  async sendVirtualAccountDeposit(
    to: string,
    params: VirtualAccountDepositEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Deposit received: ${params.amountFormatted} into your business account — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#10b981;margin-bottom:16px">Deposit Received</h2>` +
        `<p>You received a new deposit into your <strong>${escapeHtml(params.businessName)}</strong> account (${escapeHtml(params.bankName)} - ${escapeHtml(params.accountNumber.slice(-4))}):</p>` +
        `<p style="font-size:28px;font-weight:700;color:#111827;margin:16px 0">${escapeHtml(params.amountFormatted)}</p>` +
        `<p style="color:#4b5563;font-size:14px">The funds are now credited and available in your Scripe business balance.</p>` +
        `<p style="margin:24px 0"><a href="${escapeHtml(params.dashboardUrl)}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View Transaction</a></p>` +
        `</div>`,
      logHint: `deposit_received=${params.amountFormatted}`,
    });
  }

  async sendInvoiceIssued(
    to: string,
    params: InvoiceIssuedEmail,
  ): Promise<void> {
    await this.send({
      to,
      subject: `Invoice ${params.invoiceNumber} from ${params.businessName} — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        invoiceEmailHeader(params) +
        `<p style="font-size:15px;line-height:22px;color:#374151">Hello ${escapeHtml(params.customerName)},</p>` +
        `<p style="font-size:15px;line-height:22px;color:#374151">You have received invoice <strong>${escapeHtml(params.invoiceNumber)}</strong> from <strong>${escapeHtml(params.businessName)}</strong>.</p>` +
        `<div style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0">` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:8px">` +
        `<span style="color:#6b7280;font-size:13px">Invoice number:</span>` +
        `<span style="font-weight:600;font-size:13px;color:#111827">${escapeHtml(params.invoiceNumber)}</span>` +
        `</div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:8px">` +
        `<span style="color:#6b7280;font-size:13px">Amount due:</span>` +
        `<span style="font-weight:700;font-size:16px;color:#111827">${escapeHtml(params.amountFormatted)}</span>` +
        `</div>` +
        `<div style="display:flex;justify-content:space-between">` +
        `<span style="color:#6b7280;font-size:13px">Due date:</span>` +
        `<span style="font-weight:500;font-size:13px;color:#111827">${escapeHtml(params.dueDate)}</span>` +
        `</div>` +
        `</div>` +
        (params.notes
          ? `<p style="font-size:14px;color:#6b7280;font-style:italic;margin-bottom:20px">${escapeHtml(params.notes)}</p>`
          : "") +
        `<p style="margin:28px 0"><a href="${escapeHtml(params.payUrl)}" style="background-color:${invoiceButtonColor(params.brandColor)};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:24px;font-weight:600;font-size:14px;display:inline-block">View & Pay Invoice</a></p>` +
        `<p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">` +
        `If the button above does not work, visit: <br/><a href="${escapeHtml(params.payUrl)}" style="color:#FF5B1F">${escapeHtml(params.payUrl)}</a>` +
        `</p>` +
        `</div>`,
      logHint: `invoice_issued=${params.invoiceNumber}`,
    });
  }

  async sendInvoiceReminder(
    to: string,
    params: InvoiceReminderEmail,
  ): Promise<void> {
    const title = params.isOverdue
      ? "Overdue Invoice Reminder"
      : "Invoice Payment Reminder";
    await this.send({
      to,
      subject: `Reminder: Invoice ${params.invoiceNumber} from ${params.businessName} — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        invoiceEmailHeader(params) +
        `<h3 style="font-size:16px;font-weight:600;color:${params.isOverdue ? "#ef4444" : "#111827"};margin-bottom:12px">${title}</h3>` +
        `<p style="font-size:15px;line-height:22px;color:#374151">Hello ${escapeHtml(params.customerName)},</p>` +
        `<p style="font-size:15px;line-height:22px;color:#374151">This is a reminder regarding invoice <strong>${escapeHtml(params.invoiceNumber)}</strong> from <strong>${escapeHtml(params.businessName)}</strong>.</p>` +
        `<div style="background-color:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0">` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:8px">` +
        `<span style="color:#6b7280;font-size:13px">Invoice number:</span>` +
        `<span style="font-weight:600;font-size:13px;color:#111827">${escapeHtml(params.invoiceNumber)}</span>` +
        `</div>` +
        `<div style="display:flex;justify-content:space-between;margin-bottom:8px">` +
        `<span style="color:#6b7280;font-size:13px">Amount due:</span>` +
        `<span style="font-weight:700;font-size:16px;color:#111827">${escapeHtml(params.amountFormatted)}</span>` +
        `</div>` +
        `<div style="display:flex;justify-content:space-between">` +
        `<span style="color:#6b7280;font-size:13px">Due date:</span>` +
        `<span style="font-weight:500;font-size:13px;color:#111827">${escapeHtml(params.dueDate)}</span>` +
        `</div>` +
        `</div>` +
        `<p style="margin:28px 0"><a href="${escapeHtml(params.payUrl)}" style="background-color:${invoiceButtonColor(params.brandColor)};color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:24px;font-weight:600;font-size:14px;display:inline-block">View & Pay Invoice</a></p>` +
        `<p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">` +
        `If the button above does not work, visit: <br/><a href="${escapeHtml(params.payUrl)}" style="color:#FF5B1F">${escapeHtml(params.payUrl)}</a>` +
        `</p>` +
        `</div>`,
      logHint: `invoice_reminder=${params.invoiceNumber}`,
    });
  }

  async sendPurchaseOrder(to: string, params: PurchaseOrderEmail): Promise<void> {
    const cell = "padding:8px 0;font-size:13px;border-bottom:1px solid #e5e7eb";
    const rows = params.lines
      .map(
        (line) =>
          `<tr><td style="${cell};color:#111827">${escapeHtml(line.name)}</td>` +
          `<td style="${cell};color:#374151;text-align:right">${escapeHtml(line.quantity)}</td>` +
          `<td style="${cell};color:#374151;text-align:right">${escapeHtml(line.unitCostFormatted)}</td>` +
          `<td style="${cell};color:#111827;text-align:right;font-weight:500">${escapeHtml(line.totalFormatted)}</td></tr>`,
      )
      .join("");
    await this.send({
      to,
      subject: `Purchase order ${params.orderNumber} from ${params.businessName}`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        invoiceEmailHeader(params) +
        `<p style="font-size:15px;line-height:22px;color:#374151">Hello ${escapeHtml(params.supplierName)},</p>` +
        `<p style="font-size:15px;line-height:22px;color:#374151"><strong>${escapeHtml(params.businessName)}</strong> has sent you purchase order <strong>${escapeHtml(params.orderNumber)}</strong>, dated ${escapeHtml(params.orderDate)}` +
        (params.expectedDate ? `, with delivery expected by <strong>${escapeHtml(params.expectedDate)}</strong>` : "") +
        `.</p>` +
        `<table style="width:100%;border-collapse:collapse;margin:20px 0">` +
        `<thead><tr>` +
        `<th style="text-align:left;font-size:12px;color:#6b7280;font-weight:500;padding-bottom:6px">Item</th>` +
        `<th style="text-align:right;font-size:12px;color:#6b7280;font-weight:500;padding-bottom:6px">Qty</th>` +
        `<th style="text-align:right;font-size:12px;color:#6b7280;font-weight:500;padding-bottom:6px">Unit cost</th>` +
        `<th style="text-align:right;font-size:12px;color:#6b7280;font-weight:500;padding-bottom:6px">Amount</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>` +
        `<p style="text-align:right;font-size:15px;color:#111827;margin:0 0 20px">Total: <strong>${escapeHtml(params.totalFormatted)}</strong></p>` +
        (params.notes ? `<p style="font-size:14px;color:#6b7280;font-style:italic">${escapeHtml(params.notes)}</p>` : "") +
        `<p style="font-size:14px;line-height:21px;color:#374151">` +
        (params.replyToEmail
          ? `Please confirm or ask any questions by emailing <a href="mailto:${escapeHtml(params.replyToEmail)}" style="color:#FF5B1F">${escapeHtml(params.replyToEmail)}</a>.`
          : `Please contact ${escapeHtml(params.businessName)} to confirm this order.`) +
        `</p>` +
        `</div>`,
      logHint: `purchase_order=${params.orderNumber}`,
    });
  }

  private async send(email: OutboundEmail): Promise<void> {
    const environment = loadEnvironment();
    const apiKey = environment.PLUNK_API_KEY;

    if (!apiKey) {
      if (environment.NODE_ENV === "production") {
        throw new Error(
          "PLUNK_API_KEY is required in production to send email.",
        );
      }
      console.log(
        `[email:dev] to=${email.to} subject="${email.subject}" ${email.logHint}`,
      );
      return;
    }

    const response = await fetch("https://next-api.useplunk.com/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: email.to,
        subject: email.subject,
        body: email.html,
        ...((email.from ?? environment.PLUNK_FROM_EMAIL)
          ? { from: email.from ?? environment.PLUNK_FROM_EMAIL }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = (await response
        .json()
        .catch(() => null)) as PlunkSendResponse | null;
      throw new Error(
        `Plunk send failed (${response.status}): ${
          body?.message ?? response.statusText
        }`,
      );
    }
  }
}

export const emailSender: EmailSender = new PlunkEmailSender();
