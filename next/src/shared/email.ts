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
}

export class PlunkEmailSender implements EmailSender {
  async sendVerificationCode(to: string, code: string): Promise<void> {
    await this.send({
      to,
      subject: "Your Surge verification code",
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
      html: `<p>Reset your Surge account password:</p><p><a href="${url}">${url}</a></p>`,
      logHint: `link=${url}`,
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
        ...(environment.PLUNK_FROM_EMAIL
          ? { from: environment.PLUNK_FROM_EMAIL }
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
