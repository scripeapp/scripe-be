import {
  appendSmsOptOutFooter,
  calculateChannelCost,
  countSmsMessageParts,
} from "../services/channel-message-cost.service";
import { normalizeInternationalPhone } from "../utils/phone-number";

describe("channel message costing", () => {
  it("adds the SMS opt-out footer exactly once", () => {
    const message = appendSmsOptOutFooter("Hello");

    expect(message).toBe("Hello\n\nReply STOP to unsubscribe.");
    expect(appendSmsOptOutFooter(message)).toBe(message);
  });

  it("counts GSM multipart messages using concatenated part lengths", () => {
    expect(countSmsMessageParts("a".repeat(160))).toBe(1);
    expect(countSmsMessageParts("a".repeat(161))).toBe(2);
    expect(countSmsMessageParts("a".repeat(307))).toBe(3);
  });

  it("uses Unicode part lengths when the message contains non-GSM characters", () => {
    expect(countSmsMessageParts("🙂".repeat(70))).toBe(1);
    expect(countSmsMessageParts("🙂".repeat(71))).toBe(2);
  });

  it("charges SMS credits per recipient and encoded part", () => {
    const estimate = calculateChannelCost({
      channel: "sms",
      recipientCount: 10,
      body: "a".repeat(150),
    });

    expect(estimate.messageParts).toBe(2);
    expect(estimate.creditsPerRecipient).toBe(6);
    expect(estimate.requiredCredits).toBe(60);
  });

  it("charges WhatsApp once per eligible recipient", () => {
    expect(
      calculateChannelCost({
        channel: "whatsapp",
        recipientCount: 12,
        body: "Hello",
      }).requiredCredits,
    ).toBe(24);
  });
});

describe("international phone normalization", () => {
  it("converts Nigerian local numbers to international digits", () => {
    expect(normalizeInternationalPhone("0803 123 4567")).toBe("2348031234567");
  });

  it("preserves valid international numbers and rejects invalid values", () => {
    expect(normalizeInternationalPhone("+234-803-123-4567")).toBe("2348031234567");
    expect(normalizeInternationalPhone("123")) .toBeNull();
  });
});

