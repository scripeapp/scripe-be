import { appendSmsOptOutFooter, countSmsMessageParts, estimateCommunicationCost } from "./communications.cost.js";

describe("communications.cost", () => {
  it("counts a single GSM-7 part for a short message", () => {
    expect(countSmsMessageParts("Hello there!")).toBe(1);
  });

  it("splits a long GSM-7 message into multiple 153-char parts", () => {
    const body = "a".repeat(200);
    expect(countSmsMessageParts(body)).toBe(Math.ceil(200 / 153));
  });

  it("uses the tighter UCS-2 budget for non-GSM-7 characters", () => {
    const body = "こんにちは".repeat(20); // 100 chars, non-GSM-7
    expect(countSmsMessageParts(body)).toBe(Math.ceil(100 / 67));
  });

  it("appends the opt-out footer exactly once", () => {
    const withFooter = appendSmsOptOutFooter("Hello");
    expect(withFooter).toContain("Reply STOP to unsubscribe.");
    expect(appendSmsOptOutFooter(withFooter)).toBe(withFooter);
  });

  it("estimates sms cost as credits-per-part times recipients, footer included", () => {
    const estimate = estimateCommunicationCost("sms", 10, "short body");
    expect(estimate.messageParts).toBe(1);
    expect(estimate.requiredCredits).toBe(estimate.creditsPerRecipient * 10);
  });

  it("estimates whatsapp/email cost as a flat per-recipient rate", () => {
    const whatsapp = estimateCommunicationCost("whatsapp", 5, "hi");
    const email = estimateCommunicationCost("email", 5, "hi");
    expect(whatsapp.requiredCredits).toBe(whatsapp.creditsPerRecipient * 5);
    expect(email.requiredCredits).toBe(email.creditsPerRecipient * 5);
  });
});
