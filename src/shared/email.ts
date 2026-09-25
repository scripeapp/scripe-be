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
export interface EmailSender {
  sendVerificationCode(to: string, code: string): Promise<void>;
  sendPasswordResetEmail(to: string, url: string): Promise<void>;
  sendBusinessInvitation(to: string, params: BusinessInvitationEmail): Promise<void>;
  /** Arbitrary subject/body send used by the communications domain, sent as a business's own resolved sender rather than the platform's fixed templates above. */
  sendTransactional(params: { to: string; subject: string; html: string; from?: string }): Promise<void>;
  sendBankingKybSubmitted(to: string, params: BankingKybSubmittedEmail): Promise<void>;
  sendBankingKybApproved(to: string, params: BankingKybApprovedEmail): Promise<void>;
  sendBankingKybFailed(to: string, params: BankingKybFailedEmail): Promise<void>;
  sendVirtualAccountIssued(to: string, params: VirtualAccountIssuedEmail): Promise<void>;
  sendVirtualAccountDeposit(to: string, params: VirtualAccountDepositEmail): Promise<void>;
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
        `<p style="font-size:24px;font-weight:700;letter-spacing:6px">${code}</p>` +
        `<p>This code expires in 10 minutes. If you did not request it, ignore this email.</p>`,
      logHint: `code=${code}`,
    });
  }

  async sendPasswordResetEmail(to: string, url: string): Promise<void> {
    await this.send({
      to,
      subject: "Reset your password",
      html: `<p>Reset your Scripe account password:</p><p><a href="${url}">${url}</a></p>`,
      logHint: `link=${url}`,
    });
  }

  async sendBusinessInvitation(to: string, params: BusinessInvitationEmail): Promise<void> {
    await this.send({
      to,
      subject: `You've been invited to join ${params.businessName} on Scripe`,
      html:
        `<p>${params.inviterName} invited you to join <strong>${params.businessName}</strong> on Scripe.</p>` +
        `<p><a href="${params.acceptUrl}">${params.acceptUrl}</a></p>` +
        `<p>This invitation expires in 7 days. If you weren't expecting this, ignore this email.</p>`,
      logHint: `link=${params.acceptUrl}`,
    });
  }

  async sendTransactional(params: { to: string; subject: string; html: string; from?: string }): Promise<void> {
    await this.send({ ...params, logHint: "transactional" });
  }

  async sendBankingKybSubmitted(to: string, params: BankingKybSubmittedEmail): Promise<void> {
    await this.send({
      to,
      subject: `Your business verification is under review — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;margin-bottom:16px">We received your business verification</h2>` +
        `<p>Hello ${params.directorName},</p>` +
        `<p>Thank you for submitting verification details for <strong>${params.businessName}</strong>.</p>` +
        `<p>We are validating your corporate credentials against official registries (CAC, NIBSS, NIMC). This process typically takes <strong>1 to 2 business days</strong>.</p>` +
        `<p style="margin:24px 0"><a href="${params.dashboardUrl}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View Verification Status</a></p>` +
        `<p style="color:#6b7280;font-size:13px">You will receive an email as soon as your dedicated corporate account is ready.</p>` +
        `</div>`,
      logHint: `kyb_submitted=${params.businessName}`,
    });
  }

  async sendBankingKybApproved(to: string, params: BankingKybApprovedEmail): Promise<void> {
    await this.send({
      to,
      subject: `Your business verification has been approved! — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#10b981;margin-bottom:16px">Verification Approved</h2>` +
        `<p>Hello ${params.directorName},</p>` +
        `<p>Great news! The business verification for <strong>${params.businessName}</strong> has been successfully approved.</p>` +
        `<p>Your business is now eligible to generate and use a dedicated corporate bank account to collect payments and bank transfers from customers.</p>` +
        `<p style="margin:24px 0"><a href="${params.dashboardUrl}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">Go to Banking Dashboard</a></p>` +
        `</div>`,
      logHint: `kyb_approved=${params.businessName}`,
    });
  }

  async sendBankingKybFailed(to: string, params: BankingKybFailedEmail): Promise<void> {
    await this.send({
      to,
      subject: `Action required: Update your business verification — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#ef4444;margin-bottom:16px">Verification Update Required</h2>` +
        `<p>Hello ${params.directorName},</p>` +
        `<p>We encountered an issue while verifying <strong>${params.businessName}</strong>:</p>` +
        `<div style="background-color:#fef2f2;border:1px solid #fecaca;padding:12px 16px;border-radius:6px;color:#991b1b;margin:16px 0;font-size:14px">${params.reason}</div>` +
        `<p>Please review and update your information so we can complete your verification and issue your account.</p>` +
        `<p style="margin:24px 0"><a href="${params.retryUrl}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">Update Details</a></p>` +
        `</div>`,
      logHint: `kyb_failed=${params.businessName}`,
    });
  }

  async sendVirtualAccountIssued(to: string, params: VirtualAccountIssuedEmail): Promise<void> {
    await this.send({
      to,
      subject: `Your dedicated corporate account is ready — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;margin-bottom:16px">Your Business Account is Ready</h2>` +
        `<p>Your dedicated corporate bank account for <strong>${params.businessName}</strong> is active and ready to receive funds:</p>` +
        `<div style="background-color:#f9fafb;border:1px solid #e5e7eb;padding:16px;border-radius:8px;margin:16px 0">` +
        `<div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px;display:block">BANK NAME</span><strong style="font-size:15px">${params.bankName}</strong></div>` +
        `<div style="margin-bottom:8px"><span style="color:#6b7280;font-size:12px;display:block">ACCOUNT NUMBER</span><strong style="font-size:18px;letter-spacing:1px">${params.accountNumber}</strong></div>` +
        `<div><span style="color:#6b7280;font-size:12px;display:block">ACCOUNT NAME</span><strong style="font-size:15px">${params.accountName}</strong></div>` +
        `</div>` +
        `<p style="color:#4b5563;font-size:14px">Any bank transfer sent to this account will be automatically credited to your Scripe business balance.</p>` +
        `<p style="margin:24px 0"><a href="${params.dashboardUrl}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View in Dashboard</a></p>` +
        `</div>`,
      logHint: `account_issued=${params.accountNumber}`,
    });
  }

  async sendVirtualAccountDeposit(to: string, params: VirtualAccountDepositEmail): Promise<void> {
    await this.send({
      to,
      subject: `Deposit received: ${params.amountFormatted} into your business account — Scripe`,
      html:
        `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:560px;margin:0 auto;padding:24px 16px;color:#111827">` +
        `<h2 style="font-size:20px;font-weight:600;color:#10b981;margin-bottom:16px">Deposit Received</h2>` +
        `<p>You received a new deposit into your <strong>${params.businessName}</strong> account (${params.bankName} - ${params.accountNumber.slice(-4)}):</p>` +
        `<p style="font-size:28px;font-weight:700;color:#111827;margin:16px 0">${params.amountFormatted}</p>` +
        `<p style="color:#4b5563;font-size:14px">The funds are now credited and available in your Scripe business balance.</p>` +
        `<p style="margin:24px 0"><a href="${params.dashboardUrl}" style="background-color:#111827;color:#ffffff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:500;display:inline-block">View Transaction</a></p>` +
        `</div>`,
      logHint: `deposit_received=${params.amountFormatted}`,
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

    const response = await fetch("https://api.useplunk.com/v1/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        to: email.to,
        subject: email.subject,
        body: email.html,
        ...(email.from ?? environment.PLUNK_FROM_EMAIL
          ? { from: email.from ?? environment.PLUNK_FROM_EMAIL }
          : {}),
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as
        | PlunkSendResponse
        | null;
      throw new Error(
        `Plunk send failed (${response.status}): ${
          body?.message ?? response.statusText
        }`,
      );
    }
  }
}

export const emailSender: EmailSender = new PlunkEmailSender();
