import {
  eventTicketReceiptCustomer,
  eventTicketVendorNotification,
} from "../utils/emailsTemplate";
import { storeEmailService } from "../utils/storeEmails.util";
import { formatCurrency } from "../types/store";

describe("merchant payment confirmation emails", () => {
  it("renders the verified GHS amount in an event-sale notification", () => {
    const html = eventTicketVendorNotification({
      amount: 16.98,
      currency: "GHS",
      vendorName: "Merchant",
      eventID: "event-1",
      eventName: "Test Event",
      buyerName: "Buyer",
      dataTime: "2026-08-21 12:00",
      quantity: 1,
      paymentSummary: {
        currency: "GHS",
        subtotal: 20,
        discount: 4,
        surcharge: 0,
        amount: 16.98,
        coupon_code: "SAVE20",
        coupon_applied: true,
        discounts: [
          {
            rule_id: "rule-1",
            mode: "percent",
            value: 20,
            amount: 4,
            coupon_code: "SAVE20",
          },
        ],
      },
    });
    const formattedAmount = new Intl.NumberFormat("en", {
      style: "currency",
      currency: "GHS",
    }).format(16.98);

    expect(html).toContain("Amount paid");
    expect(html).toContain(formattedAmount);
    expect(html).toContain("Discount");
    expect(html).toContain("SAVE20");
    expect(html).not.toContain("₦16.98");
  });

  it("renders an event discount in the buyer ticket email", () => {
    const html = eventTicketReceiptCustomer({
      ticketId: "order-1",
      eventName: "Test Event",
      eventDate: "2026-08-21 12:00",
      venue: "Accra",
      paymentSummary: {
        currency: "GHS",
        subtotal: 20,
        discount: 4,
        surcharge: 0,
        amount: 16.98,
        coupon_code: "SAVE20",
        coupon_applied: true,
        discounts: [
          {
            rule_id: "rule-1",
            mode: "percent",
            value: 20,
            amount: 4,
            coupon_code: "SAVE20",
          },
        ],
      },
    });

    expect(html).toContain("Payment summary");
    expect(html).toContain("Discount");
    expect(html).toContain("SAVE20");
    expect(html).toContain("Amount paid");
  });

  it("renders the store order's paid amount and currency for the merchant", () => {
    const order = {
      id: "order-1",
      store_id: "store-1",
      order_number: "ORD-1",
      customer_name: "Buyer",
      customer_email: "buyer@example.com",
      items: [
        {
          product_name: "Product",
          quantity: 1,
          price: 25_000,
        },
      ],
      total: 25_000,
      currency: "NGN",
      delivery_fee: 1_000,
      shipping_carrier: "Express delivery",
      status: "paid",
      payment_reference: "FLW-5fc1f64c-b696-4054-8ae8-b7d0d02492a2",
      discount: 0,
      tax_amount: 0,
      service_charge_amount: 0,
      utensils_requested: false,
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
    };

    const html = (storeEmailService as any).generateNewOrderEmail(
      order,
      "Test Store",
      {
        amount: 16.98,
        currency: "GHS",
        subtotal: 15,
        discount: 1.52,
        deliveryFee: 3.5,
        items: [
          {
            productId: "product-1",
            name: "Product",
            quantity: 1,
            unitPrice: 15,
            lineTotal: 15,
          },
        ],
      },
    );

    expect(html).toContain("Amount paid");
    expect(html).toContain(formatCurrency(16.98, "GHS"));
    expect(html).toContain("Subtotal");
    expect(html).toContain(formatCurrency(15, "GHS"));
    expect(html).toContain("Discount");
    expect(html).toContain(`-${formatCurrency(1.52, "GHS")}`);
    expect(html).toContain("Price");
    expect(html).toContain(formatCurrency(15, "GHS"));
    expect(html).toContain("Delivery (Express delivery)");
    expect(html).toContain(formatCurrency(3.5, "GHS"));
    expect(html).not.toContain("₦16.98");
  });

  it("keeps legacy order accounting separate from the buyer payment in the customer email", () => {
    const order = {
      id: "order-1",
      store_id: "store-1",
      order_number: "ORD-1",
      customer_name: "Buyer",
      customer_email: "buyer@example.com",
      items: [{ product_name: "Product", quantity: 1, price: 25_000 }],
      subtotal: 25_000,
      total: 25_000,
      currency: "NGN",
      delivery_fee: 1_000,
      discount: 0,
      tax_amount: 0,
      service_charge_amount: 0,
      status: "paid",
      payment_reference: "FLW-5fc1f64c-b696-4054-8ae8-b7d0d02492a2",
      utensils_requested: false,
      created_at: "2026-08-21T12:00:00.000Z",
      updated_at: "2026-08-21T12:00:00.000Z",
    };

    const html = (storeEmailService as any).generateOrderConfirmationEmail(
      order,
      "Test Store",
      null,
      {
        amount: 16.98,
        currency: "GHS",
        subtotal: 15,
        discount: 1.52,
        deliveryFee: 3.5,
        items: [
          {
            productId: "product-1",
            name: "Product",
            quantity: 1,
            unitPrice: 15,
            lineTotal: 15,
          },
        ],
      },
    );

    expect(html).toContain(formatCurrency(16.98, "GHS"));
    expect(html).toContain(formatCurrency(15, "GHS"));
    expect(html).toContain(`-${formatCurrency(1.52, "GHS")}`);
    expect(html).toContain("Price");
    expect(html).toContain(formatCurrency(3.5, "GHS"));
    expect(html).not.toContain(formatCurrency(25_000, "NGN"));
  });
});
