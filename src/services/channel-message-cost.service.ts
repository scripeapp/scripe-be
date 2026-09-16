import type { ChannelType } from "../types/channel.types";

const SMS_OPT_OUT_FOOTER = "\n\nReply STOP to unsubscribe.";
const GSM_SINGLE_PAGE_LENGTH = 160;
const GSM_MULTI_PAGE_LENGTH = 153;
const UNICODE_SINGLE_PAGE_LENGTH = 70;
const UNICODE_MULTI_PAGE_LENGTH = 67;

const GSM_CHARACTERS = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà".split(
    "",
  ),
);

const GSM_EXTENSION_CHARACTERS = new Set("^{}\\[~]|€".split(""));

export interface ChannelCostEstimate {
  channel: ChannelType;
  recipientCount: number;
  creditsPerRecipient: number;
  messageParts: number;
  requiredCredits: number;
  includesOptOutFooter: boolean;
}

export function getChannelCreditRates() {
  return {
    email: 1,
    sms_per_part: readPositiveInteger("CAMPAIGN_SMS_CREDITS_PER_PART", 3),
    whatsapp: readPositiveInteger("CAMPAIGN_WHATSAPP_CREDITS_PER_MESSAGE", 2),
  } as const;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function appendSmsOptOutFooter(body: string): string {
  if (body.toLowerCase().includes("reply stop to unsubscribe")) return body;
  return `${body.trimEnd()}${SMS_OPT_OUT_FOOTER}`;
}

export function countSmsMessageParts(body: string): number {
  let encodedLength = 0;
  let isUnicode = false;

  for (const character of body) {
    if (GSM_CHARACTERS.has(character)) {
      encodedLength += 1;
      continue;
    }

    if (GSM_EXTENSION_CHARACTERS.has(character)) {
      encodedLength += 2;
      continue;
    }

    isUnicode = true;
    encodedLength += 1;
  }

  const singlePageLength = isUnicode
    ? UNICODE_SINGLE_PAGE_LENGTH
    : GSM_SINGLE_PAGE_LENGTH;
  const multiPageLength = isUnicode
    ? UNICODE_MULTI_PAGE_LENGTH
    : GSM_MULTI_PAGE_LENGTH;

  if (encodedLength <= singlePageLength) return 1;
  return Math.ceil(encodedLength / multiPageLength);
}

export function calculateChannelCost(params: {
  channel: ChannelType;
  recipientCount: number;
  body: string;
}): ChannelCostEstimate {
  const recipientCount = Math.max(0, Math.floor(params.recipientCount));
  const messageBody =
    params.channel === "sms" ? appendSmsOptOutFooter(params.body) : params.body;
  const messageParts =
    params.channel === "sms" ? countSmsMessageParts(messageBody) : 1;
  const rates = getChannelCreditRates();
  const channelRate =
    params.channel === "sms" ? rates.sms_per_part : rates.whatsapp;
  const creditsPerRecipient = channelRate * messageParts;

  return {
    channel: params.channel,
    recipientCount,
    creditsPerRecipient,
    messageParts,
    requiredCredits: recipientCount * creditsPerRecipient,
    includesOptOutFooter: params.channel === "sms",
  };
}
