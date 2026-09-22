/**
 * Pure cost-calculation helpers, no database access — ported from legacy's
 * channel-message-cost.service.ts (GSM-7 vs UCS-2 multi-part SMS math) plus
 * the same flat per-message rates for whatsapp/email.
 */

import { loadEnvironment } from "../../shared/environment.js";
import type { CommunicationChannel, CostEstimate, CreditRates } from "./communications.types.js";

// GSM 03.38 default alphabet, minus extension-table characters that count double.
const GSM_7_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_7_EXTENDED = "^{}\\[~]|€";

function isGsm7(body: string): boolean {
  for (const character of body) {
    if (!GSM_7_BASIC.includes(character) && !GSM_7_EXTENDED.includes(character)) return false;
  }
  return true;
}

function gsm7Length(body: string): number {
  let length = 0;
  for (const character of body) length += GSM_7_EXTENDED.includes(character) ? 2 : 1;
  return length;
}

/** Returns how many SMS "parts" a body requires under GSM-7 (160/153 per part) or UCS-2 (70/67 per part) segmentation rules. */
export function countSmsMessageParts(body: string): number {
  if (isGsm7(body)) {
    const length = gsm7Length(body);
    if (length <= 160) return 1;
    return Math.ceil(length / 153);
  }
  const length = body.length;
  if (length <= 70) return 1;
  return Math.ceil(length / 67);
}

const SMS_OPT_OUT_FOOTER = "\n\nReply STOP to unsubscribe.";

export function appendSmsOptOutFooter(body: string): string {
  return body.includes(SMS_OPT_OUT_FOOTER.trim()) ? body : `${body}${SMS_OPT_OUT_FOOTER}`;
}

export function getCommunicationCreditRates(): CreditRates {
  const environment = loadEnvironment();
  return {
    email: environment.COMMUNICATIONS_EMAIL_CREDITS_PER_MESSAGE,
    smsPerPart: environment.COMMUNICATIONS_SMS_CREDITS_PER_PART,
    whatsapp: environment.COMMUNICATIONS_WHATSAPP_CREDITS_PER_MESSAGE,
  };
}

export function estimateCommunicationCost(channel: CommunicationChannel, recipientCount: number, body: string): CostEstimate {
  const rates = getCommunicationCreditRates();
  if (channel === "sms") {
    const messageParts = countSmsMessageParts(appendSmsOptOutFooter(body));
    const creditsPerRecipient = rates.smsPerPart * messageParts;
    return { channel, recipientCount, creditsPerRecipient, messageParts, requiredCredits: creditsPerRecipient * recipientCount };
  }
  const creditsPerRecipient = channel === "whatsapp" ? rates.whatsapp : rates.email;
  return { channel, recipientCount, creditsPerRecipient, messageParts: 1, requiredCredits: creditsPerRecipient * recipientCount };
}
