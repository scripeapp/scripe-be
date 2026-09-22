import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { MessageChannel, MessageProvider, SendMessageInput, SendMessageResult } from "../message-provider.js";

interface TermiiResponse {
  code?: string;
  message?: string;
  message_id?: string;
}

/** https://developers.termii.com/messaging — one HTTP endpoint for both sms and whatsapp, distinguished by the "channel" field. */
export class TermiiMessageProvider implements MessageProvider {
  readonly name = "termii";

  constructor(private readonly channel: MessageChannel) {}

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const environment = loadEnvironment();
    const apiKey = environment.TERMII_API_KEY;
    const senderId = environment.TERMII_SENDER_ID;
    if (!apiKey || !senderId) throw serviceUnavailableError("Termii is not configured (missing TERMII_API_KEY or TERMII_SENDER_ID).");

    const response = await fetch(`${environment.TERMII_BASE_URL}/api/sms/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        to: input.to,
        from: senderId,
        sms: input.body,
        type: "plain",
        channel: this.channel === "whatsapp" ? "whatsapp" : "generic",
      }),
    });

    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      throw new Error(`Termii request failed transiently (HTTP ${response.status}); retry later.`);
    }

    const payload = (await response.json().catch(() => ({}))) as TermiiResponse;
    if (!response.ok || payload.code === "err") {
      return { accepted: false, providerMessageId: null, errorMessage: payload.message ?? `Termii rejected the message (HTTP ${response.status}).` };
    }
    return { accepted: true, providerMessageId: payload.message_id ?? null, errorMessage: null };
  }
}
