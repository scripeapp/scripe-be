import { loadEnvironment } from "../../shared/environment.js";
import { serviceUnavailableError } from "../../shared/errors.js";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "../message-provider.js";

interface MetaResponse {
  messages?: { id: string }[];
  error?: { message?: string };
}

/** https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages — whatsapp only, free-form text session message. */
export class MetaCloudMessageProvider implements MessageProvider {
  readonly name = "meta";

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const environment = loadEnvironment();
    const { META_WA_TOKEN: token, META_WA_PHONE_NUMBER_ID: phoneNumberId } = environment;
    if (!token || !phoneNumberId) throw serviceUnavailableError("Meta Cloud is not configured (missing META_WA_TOKEN or META_WA_PHONE_NUMBER_ID).");

    const response = await fetch(`https://graph.facebook.com/v22.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: input.to,
        type: "text",
        text: { body: input.body },
      }),
    });

    if (response.status === 429 || response.status >= 500) throw new Error(`Meta Cloud request failed transiently (HTTP ${response.status}); retry later.`);

    const payload = (await response.json().catch(() => ({}))) as MetaResponse;
    if (!response.ok || !payload.messages?.[0]?.id) {
      return { accepted: false, providerMessageId: null, errorMessage: payload.error?.message ?? `Meta Cloud rejected the message (HTTP ${response.status}).` };
    }
    return { accepted: true, providerMessageId: payload.messages[0].id, errorMessage: null };
  }
}
