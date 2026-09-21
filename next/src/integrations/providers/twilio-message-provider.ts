import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "../message-provider.js";

interface TwilioResponse {
  sid?: string;
  status?: string;
  code?: number;
  message?: string;
}

/** https://www.twilio.com/docs/sms/api/message-resource — sms only; Basic-auth, form-encoded body. */
export class TwilioMessageProvider implements MessageProvider {
  readonly name = "twilio";

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const environment = loadEnvironment();
    const { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_FROM_NUMBER: fromNumber } = environment;
    if (!accountSid || !authToken || !fromNumber) throw serviceUnavailableError("Twilio is not configured (missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER).");

    const body = new URLSearchParams({ To: input.to, From: fromNumber, Body: input.body });
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (response.status === 429 || response.status >= 500) throw new Error(`Twilio request failed transiently (HTTP ${response.status}); retry later.`);

    const payload = (await response.json().catch(() => ({}))) as TwilioResponse;
    if (!response.ok) return { accepted: false, providerMessageId: null, errorMessage: payload.message ?? `Twilio rejected the message (HTTP ${response.status}).` };
    return { accepted: true, providerMessageId: payload.sid ?? null, errorMessage: null };
  }
}
