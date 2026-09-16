/**
 * Tests for StoreEmailService order confirmation email.
 *
 * Focuses on the merchant's after-purchase message being attached to the
 * confirmation email as a "Message from {store}" block.
 */

jest.mock("../config/supabase", () => ({ supabaseAdmin: {} }));

jest.mock("../services/email.service", () => ({
  emailService: { send: jest.fn().mockResolvedValue(undefined) },
}));

import { storeEmailService } from "../utils/storeEmails.util";
import { emailService } from "../services/email.service";
import { Order } from "../types/store";

const sendMock = emailService.send as jest.Mock;

function buildOrder(): Order {
  return {
    id: "order-1",
    order_number: "ORD-1",
    customer_name: "Ada",
    customer_email: "ada@example.com",
    items: [{ product_name: "Notebook", quantity: 1, price: 2000 }],
    subtotal: 2000,
    discount: 0,
    total: 2000,
    payment_reference: "ref-1",
    created_at: new Date().toISOString(),
  } as unknown as Order;
}

function lastSentBody(): string {
  return sendMock.mock.calls[sendMock.mock.calls.length - 1][0].body;
}

describe("StoreEmailService.sendOrderConfirmation", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("attaches the merchant message to the confirmation email", async () => {
    await storeEmailService.sendOrderConfirmation(
      buildOrder(),
      "Acme",
      undefined,
      "Your order ships in 3 days. Thank you!",
    );

    const body = lastSentBody();
    expect(body).toContain("Message from Acme");
    expect(body).toContain("Your order ships in 3 days. Thank you!");
  });

  it("omits the merchant block when no message is set", async () => {
    await storeEmailService.sendOrderConfirmation(buildOrder(), "Acme");

    expect(lastSentBody()).not.toContain("Message from Acme");
  });

  it("omits the merchant block for a whitespace-only message", async () => {
    await storeEmailService.sendOrderConfirmation(
      buildOrder(),
      "Acme",
      undefined,
      "   ",
    );

    expect(lastSentBody()).not.toContain("Message from Acme");
  });
});
