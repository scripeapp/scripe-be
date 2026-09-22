import { loadEnvironment } from "../shared/environment.js";
import { serviceUnavailableError } from "../shared/errors.js";
import { DevMessageProvider } from "./providers/dev-message-provider.js";
import { MetaCloudMessageProvider } from "./providers/meta-cloud-message-provider.js";
import { TermiiMessageProvider } from "./providers/termii-message-provider.js";
import { TwilioMessageProvider } from "./providers/twilio-message-provider.js";

export type MessageChannel = "sms" | "whatsapp";

export interface SendMessageInput {
  readonly to: string;
  readonly body: string;
}

export interface SendMessageResult {
  readonly accepted: boolean;
  readonly providerMessageId: string | null;
  readonly errorMessage: string | null;
}

/** Ported from legacy's channel-provider.ts. Transient provider errors (rate limit, 5xx) throw so the caller can distinguish "try again" from "this recipient was rejected" (accepted: false). */
export interface MessageProvider {
  readonly name: string;
  send(input: SendMessageInput): Promise<SendMessageResult>;
}

/** Selects the provider for a channel from env, mirroring legacy's SMS_PROVIDER/WHATSAPP_PROVIDER with a "dev" (no-op, accept-everything) fallback outside production. */
export function getMessageProvider(channel: MessageChannel): MessageProvider {
  const environment = loadEnvironment();
  const configured = channel === "sms" ? environment.SMS_PROVIDER : environment.WHATSAPP_PROVIDER;
  const name = configured ?? (environment.NODE_ENV === "production" ? "termii" : "dev");

  if (name === "dev") {
    if (environment.NODE_ENV === "production") throw serviceUnavailableError("The dev message provider cannot be used in production.");
    return new DevMessageProvider();
  }
  if (name === "termii") return new TermiiMessageProvider(channel);
  if (name === "twilio") {
    if (channel !== "sms") throw serviceUnavailableError("Twilio only supports the sms channel.");
    return new TwilioMessageProvider();
  }
  if (name === "meta") {
    if (channel !== "whatsapp") throw serviceUnavailableError("Meta Cloud only supports the whatsapp channel.");
    return new MetaCloudMessageProvider();
  }
  throw serviceUnavailableError(`Unsupported message provider "${String(name)}" for channel "${channel}".`);
}
