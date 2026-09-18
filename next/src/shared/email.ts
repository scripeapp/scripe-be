import { loadEnvironment } from "./environment.js";

interface PlunkSendResponse {
  success: boolean;
  email?: string;
  message?: string;
}

/**
 * Sends transactional emails via Plunk (REST). In development/test without a
 * PLUNK_API_KEY the email is logged instead, so local flows still complete.
 * In production a missing key is a hard failure (validated at startup).
 */
export interface EmailSender {
  sendVerificationEmail(to: string, url: string): Promise<void>;
  sendPasswordResetEmail(to: string, url: string): Promise<void>;
}

export class PlunkEmailSender implements EmailSender {
  async sendVerificationEmail(to: string, url: string): Promise<void> {
    await this.send({
      to,
      subject: "Verify your email address",
      link: url,
      html: `<p>Verify your email to activate your Surge account:</p><p><a href="${url}">${url}</a></p>`,
    });
  }

  async sendPasswordResetEmail(to: string, url: string): Promise<void> {
    await this.send({
      to,
      subject: "Reset your password",
      link: url,
      html: `<p>Reset your Surge account password:</p><p><a href="${url}">${url}</a></p>`,
    });
  }

  private async send(message: {
    to: string;
    subject: string;
    link: string;
    html: string;
  }): Promise<void> {
    const environment = loadEnvironment();
    const apiKey = environment.PLUNK_API_KEY;

    if (!apiKey) {
      if (environment.NODE_ENV === "production") {
        throw new Error(
          "PLUNK_API_KEY is required in production to send email.",
        );
      }
      console.log(
        `[email:dev] to=${message.to} subject="${message.subject}" link=${message.link}`,
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
        to: message.to,
        subject: message.subject,
        body: message.html,
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
