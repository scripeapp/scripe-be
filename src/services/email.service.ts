/**
 * Email Service
 *
 * Centralized service for sending emails via the Plunk REST API.
 * Extracted from webhook.controller.ts for reusability.
 */

import { sendEmail, isConfigured } from "../config/plunk";
import { supabaseAdmin } from "../config/supabase";

import {
  eventTicketReceiptCustomer,
  eventTicketVendorNotification,
  tippingConfirmationEmail,
  membershipWelcomeEmail,
  auditEventEmail,
  sanitizeEditorHtml,
} from "../utils/emailsTemplate";
import type { EventPaymentSummary } from "../types/webhook";

export type EmailType = "platform" | "business";

export interface SendEmailOptions {
  to: string;
  subject: string;
  body: string; // HTML or Markdown
  type: EmailType;
  businessId?: string; // Required if type === 'business'
  metadata?: Record<string, any>; // For tagging/logging
  // Overrides (use carefully)
  forceReplyTo?: string;
  forceSenderName?: string;
}

interface SenderIdentity {
  name: string;
  email: string;
  replyTo?: string;
}

class EmailService {
  // Default values for new functionality
  private defaultSenderEmail = "notifications@hilaq.com";
  private platformSenderEmail = "support@hilaq.com";
  private platformSenderName = "Hilaq";

  /**
   * Send tipping confirmation email
   */
  async sendTippingEmail(params: {
    userEmail: string;
    userName: string;
    recipientName: string;
  }): Promise<void> {
    const { userEmail, userName, recipientName } = params;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping tipping email.",
      );
      return;
    }

    await sendEmail({
      to: userEmail,
      name: "Hilaq",
      subject: "Your tip has been sent successfully!",
      body: tippingConfirmationEmail({ userName, recipientName }),
      type: "html",
    });
  }

  /**
   * Send membership welcome email
   */
  async sendMembershipEmail(params: {
    userEmail: string;
    userName: string;
    planId?: string;
  }): Promise<void> {
    const { userEmail, userName, planId } = params;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping membership email.",
      );
      return;
    }

    await sendEmail({
      to: userEmail,
      name: "Hilaq Membership",
      subject: `Welcome to Hilaq ${planId?.toLowerCase() === "pro" ? "Pro" : "Plus"} Membership!`,
      body: membershipWelcomeEmail({ userName, planId }),
      type: "html",
    });
  }

  /**
   * Send "your certificate of attendance is ready" email.
   */
  async sendCertificateAvailableEmail(params: {
    to: string;
    name: string;
    eventName: string;
    url: string;
  }): Promise<void> {
    const { to, name, eventName, url } = params;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping certificate email.",
      );
      return;
    }

    const body = `
      <div style="font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #111827;">
        <h2 style="font-size: 20px; margin-bottom: 8px;">Your certificate is ready 🎉</h2>
        <p style="font-size: 14px; line-height: 1.6; color: #374151;">
          Hi ${name},<br/><br/>
          Thank you for attending <strong>${eventName}</strong>. Your certificate of
          attendance is now available. Click below to view and download it.
        </p>
        <p style="margin: 24px 0;">
          <a href="${url}" style="display: inline-block; background: #5046E5; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 9999px; font-size: 14px; font-weight: 600;">
            View Certificate
          </a>
        </p>
        <p style="font-size: 12px; color: #9CA3AF;">
          If the button doesn't work, copy and paste this link:<br/>
          <a href="${url}" style="color: #6B7280;">${url}</a>
        </p>
      </div>
    `;

    await sendEmail({
      to,
      name: "Hilaq Events",
      subject: `Your certificate for ${eventName}`,
      body,
      type: "html",
    });
  }

  /**
   * Convert a Draft.js raw JSON string to sanitized email-safe HTML.
   * Returns an empty string if parsing fails — receipt still sends, just without the custom message.
   */
  private convertDraftMessageToHtml(draftJsonString: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const draftToHtml = require("draftjs-to-html") as (raw: object) => string;
    try {
      const raw = JSON.parse(draftJsonString) as object;
      return sanitizeEditorHtml(draftToHtml(raw));
    } catch {
      return "";
    }
  }

  /**
   * Send event ticket receipt email to customer
   */
  async sendTicketReceiptEmail(params: {
    userEmail: string;
    ticketId: string;
    eventName: string;
    eventDate: string;
    venue: string;
    registrationNumber?: number | null;
    confirmationEmail?: { subject?: string; message?: string } | null;
    googleCalendarUrl?: string | null;
    icsUrl?: string | null;
    dateTbd?: boolean;
    paymentSummary?: EventPaymentSummary;
  }): Promise<void> {
    const { userEmail, ticketId, eventName, eventDate, venue, registrationNumber, confirmationEmail, googleCalendarUrl, icsUrl, dateTbd } = params;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping ticket receipt email.",
      );
      return;
    }

    // Resolve subject — use merchant's custom subject if within allowed length
    const defaultSubject = `Your ticket for ${eventName}`;
    const customSubject = confirmationEmail?.subject?.trim();
    const subject =
      customSubject && customSubject.length <= 200 ? customSubject : defaultSubject;

    // Resolve merchant message — convert Draft.js JSON → sanitized HTML, enforce max size
    let customMessage: string | undefined;
    if (confirmationEmail?.message?.trim()) {
      const converted = this.convertDraftMessageToHtml(confirmationEmail.message);
      customMessage = converted.length > 0 && converted.length <= 5000 ? converted : undefined;
    }

    await sendEmail({
      to: userEmail,
      name: "Hilaq Events",
      subject,
      type: "html",
      body: eventTicketReceiptCustomer({
        ticketId,
        eventName,
        eventDate,
        venue,
        registrationNumber,
        customMessage,
        googleCalendarUrl,
        icsUrl,
        dateTbd,
        paymentSummary: params.paymentSummary,
      }),
    });
  }

  /**
   * Send vendor notification for ticket sale
   */
  async sendVendorSaleEmail(params: {
    vendorEmail: string;
    vendorName: string;
    eventId: string;
    eventName: string;
    buyerName: string;
    amount: number;
    currency: string;
    quantity: number;
    dateTime: string;
    paymentSummary?: EventPaymentSummary;
  }): Promise<void> {
    const { vendorEmail, ...emailData } = params;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping vendor sale email.",
      );
      return;
    }

    await sendEmail({
      to: vendorEmail,
      name: "Hilaq Events",
      subject: "🎉 New Ticket Sale on Hilaq!",
      type: "html",
      body: eventTicketVendorNotification({
        amount: emailData.amount,
        currency: emailData.currency,
        vendorName: emailData.vendorName,
        eventID: emailData.eventId,
        eventName: emailData.eventName,
        buyerName: emailData.buyerName,
        quantity: emailData.quantity,
        dataTime: emailData.dateTime,
        paymentSummary: emailData.paymentSummary,
      }),
    });
  }

  /**
   * Send audit event email for logging/debugging
   */
  async sendAuditEvent(params: {
    toEmail: string;
    eventName: string;
    payload: Record<string, any>;
  }): Promise<void> {
    const { toEmail, eventName, payload } = params;

    if (!isConfigured()) {
      // Quietly return or log check - usually audit is optional
      return;
    }

    const timestamp = new Date().toISOString();
    const subject = `[Audit] ${eventName}`;
    const formatted = JSON.stringify(
      { timestamp, event: eventName, ...payload },
      null,
      2,
    );

    await sendEmail({
      to: toEmail,
      name: "Hilaq Audit",
      subject,
      type: "html",
      body: auditEventEmail({
        eventName,
        formattedPayload: formatted,
      }),
    });
  }

  /**
   * Send an email with enforced sender identity rules
   */
  async send(options: SendEmailOptions): Promise<void> {
    const { to, subject, body, type, businessId } = options;

    if (!isConfigured()) {
      console.warn(
        "[EmailService] Plunk not configured. Skipping email:",
        subject,
      );
      return;
    }

    if (type === "business" && !businessId) {
      throw new Error(
        "[EmailService] Business ID is required for business emails",
      );
    }

    const sender = await this.resolveSenderIdentity(
      type,
      businessId,
      options.forceSenderName,
    );

    console.log(
      `[EmailService] Sending [${type}] email to ${to} from "${sender.name}" <${sender.email}>`,
    );

    try {
      await sendEmail({
        to,
        subject,
        body,
        name: sender.name,
        from: sender.email,
        replyTo: sender.replyTo || sender.email,
        type: "html",
      });
    } catch (error) {
      console.error("[EmailService] Failed to send email:", error);
      throw error;
    }
  }

  /**
   * Resolve the "From" and "Reply-To" headers based on classification
   */
  private async resolveSenderIdentity(
    type: EmailType,
    businessId?: string,
    forceName?: string,
  ): Promise<SenderIdentity> {
    // 1. Platform Email
    if (type === "platform") {
      return {
        name: this.platformSenderName,
        email: this.platformSenderEmail, // e.g. support@hilaq.com
        replyTo: this.platformSenderEmail,
      };
    }

    // 2. Business Email
    if (!businessId)
      throw new Error("Business ID required for identity resolution");

    // Fetch business details
    const { data: business, error } = await supabaseAdmin
      .from("businesses")
      .select("name, support_email") // Future: select email_settings column
      .eq("id", businessId)
      .single();

    if (error || !business) {
      console.warn(
        `[EmailService] Business ${businessId} not found. Falling back to platform identity.`,
      );
      return {
        name: forceName || "Hilaq Business",
        email: this.defaultSenderEmail,
      };
    }

    const senderName = forceName || business.name;
    const senderEmail = this.defaultSenderEmail; // Default for now until domain verification is built
    const replyTo = business.support_email; // Default reply-to is the business contact email

    return {
      name: senderName,
      email: senderEmail,
      replyTo,
    };
  }

  /**
   * Send a raw HTML email (for platform-level transactional emails)
   */
  async sendRawEmail(params: { to: string; subject: string; html: string }): Promise<void> {
    if (!isConfigured()) {
      console.warn("[EmailService] Plunk not configured. Skipping raw email.");
      return;
    }
    await sendEmail({
      to: params.to,
      subject: params.subject,
      body: params.html,
      name: this.platformSenderName,
      type: "html",
    });
  }

  /** Send a short-lived challenge before a merchant changes settlement details. */
  async sendSettlementAccountVerificationEmail(params: {
    to: string;
    code: string;
    expiresInMinutes: number;
  }): Promise<void> {
    await this.sendRawEmail({
      to: params.to,
      subject: "Confirm your Hilaq settlement account change",
      html: `<p>Someone requested a change to your Hilaq settlement account.</p>
<p>Your verification code is:</p>
<p style="font-size:28px;font-weight:700;letter-spacing:8px;font-family:monospace">${params.code}</p>
<p>This code expires in ${params.expiresInMinutes} minutes and can only be used once. If you did not request this change, secure your account immediately.</p>`,
    });
  }

  /**
   * Notify an admin that a merchant has requested a payout.
   */
  async sendPayoutRequestEmail(params: {
    to: string;
    businessName: string;
    amount: number;
  }): Promise<void> {
    const formattedAmount = `₦${params.amount.toLocaleString()}`;
    await this.sendRawEmail({
      to: params.to,
      subject: `Payout request: ${params.businessName} — ${formattedAmount}`,
      html: `<p><strong>${params.businessName}</strong> has requested a payout of <strong>${formattedAmount}</strong>.</p>
<p>Review it in the Payout Requests tab of the admin dashboard, then settle the subaccount in Paystack.</p>`,
    });
  }
}

// Singleton instance
export const emailService = new EmailService();

export default EmailService;
