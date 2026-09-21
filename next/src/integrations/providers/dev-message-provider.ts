import { randomUUID } from "node:crypto";
import type { MessageProvider, SendMessageInput, SendMessageResult } from "../message-provider.js";

/** No-op provider for local development and tests — accepts every message without calling out. Refused outside production is enforced by the factory, not here. */
export class DevMessageProvider implements MessageProvider {
  readonly name = "dev";

  send(input: SendMessageInput): Promise<SendMessageResult> {
    console.log(`[dev-message-provider] would send to ${input.to}: ${input.body.slice(0, 80)}`);
    return Promise.resolve({ accepted: true, providerMessageId: `dev-${randomUUID()}`, errorMessage: null });
  }
}
