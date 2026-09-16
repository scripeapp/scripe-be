export interface ChannelDeliveryRequest {
  to: string;
  body: string;
  senderId?: string;
}

export interface ChannelDeliveryResult {
  accepted: boolean;
  providerMessageId?: string;
  error?: string;
}

export interface ChannelProvider {
  send(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

type ProviderName = "termii" | "meta" | "twilio" | "dev";

function readJsonObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

async function readResponseBody(response: Response): Promise<Record<string, unknown>> {
  try {
    return readJsonObject(await response.json());
  } catch {
    return {};
  }
}

class DevProvider implements ChannelProvider {
  async send(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    console.info("[ChannelDelivery] Development delivery accepted", {
      to: request.to,
      characters: request.body.length,
    });
    return {
      accepted: true,
      providerMessageId: `dev-${Date.now()}-${request.to.slice(-4)}`,
    };
  }
}

class TermiiProvider implements ChannelProvider {
  private readonly apiKey: string;
  private readonly senderId: string;
  private readonly baseUrl: string;

  constructor(private readonly channel: "sms" | "whatsapp") {
    this.apiKey = process.env.TERMII_API_KEY || "";
    this.senderId = process.env.TERMII_SENDER_ID || "";
    this.baseUrl = (process.env.TERMII_BASE_URL || "").replace(/\/+$/, "");

    if (!this.apiKey || !this.senderId || !this.baseUrl) {
      throw new Error(
        "Termii requires TERMII_API_KEY, TERMII_SENDER_ID, and the account-specific TERMII_BASE_URL.",
      );
    }
  }

  async send(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const route =
      this.channel === "whatsapp"
        ? "whatsapp"
        : process.env.TERMII_SMS_CHANNEL || "generic";
    const timeout = Number(process.env.TERMII_REQUEST_TIMEOUT_MS || 15000);
    const response = await fetch(`${this.baseUrl}/api/sms/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(timeout),
      body: JSON.stringify({
        api_key: this.apiKey,
        to: request.to,
        from: request.senderId || this.senderId,
        sms: request.body,
        type: "plain",
        channel: route,
      }),
    });
    const data = await readResponseBody(response);
    const providerError = readString(data.message);

    if (
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500
    ) {
      throw new Error(
        providerError || `Termii is temporarily unavailable (${response.status}).`,
      );
    }

    if (!response.ok || data.code === "err") {
      return {
        accepted: false,
        error: providerError || `Termii rejected the request (${response.status}).`,
      };
    }

    const providerMessageId =
      readString(data.message_id) || readString(data.messageId) || readString(data.id);
    if (!providerMessageId) {
      return {
        accepted: false,
        error: providerError || "Termii accepted the request without a message ID.",
      };
    }

    return { accepted: true, providerMessageId };
  }
}

class TwilioProvider implements ChannelProvider {
  private readonly accountSid = process.env.TWILIO_ACCOUNT_SID || "";
  private readonly authToken = process.env.TWILIO_AUTH_TOKEN || "";
  private readonly fromNumber = process.env.TWILIO_FROM_NUMBER || "";

  constructor() {
    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new Error("Twilio provider configuration is incomplete.");
    }
  }

  async send(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const authorization = Buffer.from(
      `${this.accountSid}:${this.authToken}`,
    ).toString("base64");
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${authorization}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          To: request.to,
          From: request.senderId || this.fromNumber,
          Body: request.body,
        }).toString(),
      },
    );
    const data = await readResponseBody(response);

    if (!response.ok) {
      return {
        accepted: false,
        error: readString(data.message) || `Twilio rejected the request (${response.status}).`,
      };
    }

    return { accepted: true, providerMessageId: readString(data.sid) };
  }
}

class MetaCloudProvider implements ChannelProvider {
  private readonly token = process.env.META_WA_TOKEN || "";
  private readonly phoneNumberId = process.env.META_WA_PHONE_NUMBER_ID || "";

  constructor() {
    if (!this.token || !this.phoneNumberId) {
      throw new Error("Meta WhatsApp provider configuration is incomplete.");
    }
  }

  async send(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult> {
    const response = await fetch(
      `https://graph.facebook.com/v22.0/${this.phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: request.to,
          type: "text",
          text: { body: request.body },
        }),
      },
    );
    const data = await readResponseBody(response);
    const error = readJsonObject(data.error);
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const firstMessage = readJsonObject(messages[0]);

    if (!response.ok || data.error) {
      return {
        accepted: false,
        error: readString(error.message) || `Meta rejected the request (${response.status}).`,
      };
    }

    return { accepted: true, providerMessageId: readString(firstMessage.id) };
  }
}

function getProviderName(channel: "sms" | "whatsapp"): ProviderName {
  const configured =
    channel === "whatsapp"
      ? process.env.WHATSAPP_PROVIDER
      : process.env.SMS_PROVIDER;
  const fallback = process.env.NODE_ENV === "production" ? "termii" : "dev";
  return (configured || fallback).toLowerCase() as ProviderName;
}

export function getChannelProvider(channel: "sms" | "whatsapp"): ChannelProvider {
  const providerName = getProviderName(channel);

  if (providerName === "termii") return new TermiiProvider(channel);
  if (providerName === "twilio") return new TwilioProvider();
  if (providerName === "meta" && channel === "whatsapp") {
    return new MetaCloudProvider();
  }
  if (providerName === "dev" && process.env.NODE_ENV !== "production") {
    return new DevProvider();
  }

  throw new Error(`${providerName} is not a supported ${channel} provider.`);
}
