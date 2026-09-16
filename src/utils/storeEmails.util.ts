import { emailService } from "../services/email.service";
import { NotificationUtil } from "./notification.util";
import { formatCurrency, Order, ServiceBooking } from "../types/store";
import { wrapInBaseEmail, emailComponents } from "./email/BaseEmail";
import { supabaseAdmin } from "../config/supabase";

export interface PaymentEmailSummary {
  amount: number;
  currency: string;
  subtotal?: number;
  discount?: number;
  deliveryFee?: number;
  tax?: number;
  serviceCharge?: number;
  items?: Array<{
    productId: string;
    name: string;
    variantName?: string | null;
    // Structured multi-axis breakdown (e.g. Size: 250g, Spice Level: Extra
    // Hot) — preferred over variantName for display when present.
    variantOptions?: Array<{ name: string; value: string }> | null;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

type ResolvedPaymentEmailSummary = Required<
  Omit<PaymentEmailSummary, "items">
> & {
  items: NonNullable<PaymentEmailSummary["items"]>;
};

/**
 * Store Email Service
 * Handles all email notifications for the Store feature
 * Uses centralized EmailService for delivery
 */
class StoreEmailService {
  private resolveCustomerEmail(order: Order): string | null {
    const email = (order?.customer_email || "").trim();
    return email.length > 0 ? email : null;
  }

  private resolveOrderNumber(order: Order): string {
    return order?.order_number || order?.id || "N/A";
  }

  private resolveOrderItems(order: Order): any[] {
    return Array.isArray(order?.items) ? order.items : [];
  }

  /** "Size: 250g, Spice Level: Extra Hot" — or the plain legacy variant
   *  name when this order predates structured variant_options. */
  private formatVariantDescription(item: {
    variantName?: string | null;
    variantOptions?: Array<{ name: string; value: string }> | null;
  }): string | null {
    if (item.variantOptions && item.variantOptions.length > 0) {
      return item.variantOptions.map((o) => `${o.name}: ${o.value}`).join(", ");
    }
    return item.variantName ?? null;
  }

  private resolvePaymentSummary(
    order: Order,
    paymentSummary?: PaymentEmailSummary,
  ): ResolvedPaymentEmailSummary {
    return {
      amount: paymentSummary?.amount ?? order.total ?? 0,
      currency: paymentSummary?.currency ?? order.currency ?? "NGN",
      subtotal: paymentSummary?.subtotal ?? order.subtotal ?? 0,
      discount: paymentSummary?.discount ?? order.discount ?? 0,
      deliveryFee:
        paymentSummary?.deliveryFee ?? (order.delivery_fee || 0),
      tax: paymentSummary?.tax ?? order.tax_amount ?? 0,
      serviceCharge:
        paymentSummary?.serviceCharge ?? order.service_charge_amount ?? 0,
      items:
        paymentSummary?.items ??
        this.resolveOrderItems(order).map((item) => ({
          productId: item.product_id ?? "",
          name: item.product_name ?? "Item",
          variantName: item.variant_name ?? null,
          variantOptions: item.variant_options ?? null,
          quantity: item.quantity ?? 1,
          unitPrice: item.price ?? 0,
          lineTotal: (item.price ?? 0) * (item.quantity ?? 1),
        })),
    };
  }

  /**
   * Send order confirmation email to customer
   */
  async sendOrderConfirmation(
    order: Order,
    storeName: string,
    businessId?: string,
    afterPurchaseMessage?: string | null,
    paymentSummary?: PaymentEmailSummary,
  ): Promise<void> {
    const customerEmail = this.resolveCustomerEmail(order);
    if (!customerEmail) {
      console.warn(
        `[StoreEmailService] Skipping order confirmation (missing customer email). order_id=${order?.id}`,
      );
      return;
    }

    try {
      const emailBody = this.generateOrderConfirmationEmail(
        order,
        storeName,
        afterPurchaseMessage,
        paymentSummary,
      );

      await emailService.send({
        to: customerEmail,
        subject: `Order Confirmation - ${this.resolveOrderNumber(order)}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Order confirmation email sent to ${customerEmail}`);
    } catch (error) {
      console.error("Failed to send order confirmation email:", error);
    }
  }

  /**
   * Send order fulfillment notification
   */
  async sendFulfillmentNotification(
    order: Order,
    storeName: string,
    businessId?: string,
  ): Promise<void> {
    const customerEmail = this.resolveCustomerEmail(order);
    if (!customerEmail) {
      console.warn(
        `[StoreEmailService] Skipping fulfillment email (missing customer email). order_id=${order?.id}`,
      );
      return;
    }

    // Check if customer wants order updates
    if (order.user_id) {
      const shouldSend = await NotificationUtil.shouldSendNotification(
        order.user_id,
        "email_order_updates",
      );
      if (!shouldSend) {
        console.log(
          `Skipping fulfillment notification for user ${order.user_id} based on preferences`,
        );
        return;
      }
    }

    try {
      const emailBody = this.generateFulfillmentEmail(order, storeName);

      await emailService.send({
        to: customerEmail,
        subject: `Order Fulfilled - ${this.resolveOrderNumber(order)}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Fulfillment email sent to ${customerEmail}`);
    } catch (error) {
      console.error("Failed to send fulfillment email:", error);
    }
  }

  /**
   * Send shipping update email
   */
  async sendShippingUpdate(
    order: Order,
    storeName: string,
    businessId?: string,
  ): Promise<void> {
    const customerEmail = this.resolveCustomerEmail(order);
    if (!customerEmail) {
      console.warn(
        `[StoreEmailService] Skipping shipping email (missing customer email). order_id=${order?.id}`,
      );
      return;
    }

    // Check preferences
    if (order.user_id) {
      const shouldSend = await NotificationUtil.shouldSendNotification(
        order.user_id,
        "email_order_updates",
      );
      if (!shouldSend) {
        console.log(
          `Skipping shipping update for user ${order.user_id} based on preferences`,
        );
        return;
      }
    }

    try {
      const emailBody = this.generateShippingEmail(order, storeName);

      await emailService.send({
        to: customerEmail,
        subject: `Shipping Update - ${this.resolveOrderNumber(order)}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Shipping update email sent to ${customerEmail}`);
    } catch (error) {
      console.error("Failed to send shipping email:", error);
    }
  }

  /**
   * Send digital product download links
   */
  async sendDigitalProductLinks(
    order: Order,
    downloadLinks: string[],
    storeName: string,
    businessId?: string,
  ): Promise<void> {
    const customerEmail = this.resolveCustomerEmail(order);
    if (!customerEmail) {
      console.warn(
        `[StoreEmailService] Skipping digital product email (missing customer email). order_id=${order?.id}`,
      );
      return;
    }

    try {
      const emailBody = this.generateDigitalProductEmail(
        order,
        downloadLinks,
        storeName,
      );

      await emailService.send({
        to: customerEmail,
        subject: `Your Digital Products - ${this.resolveOrderNumber(order)}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Digital product email sent to ${customerEmail}`);
    } catch (error) {
      console.error("Failed to send digital product email:", error);
    }
  }

  /**
   * Notify a buyer that their (physical/non-digital) pre-ordered item has been
   * released and is now being prepared for shipping.
   */
  async sendPreOrderReleaseNotification(
    order: Order,
    storeName: string,
    releaseDetails: { itemNames: string[]; message: string | null },
    businessId?: string,
  ): Promise<void> {
    const customerEmail = this.resolveCustomerEmail(order);
    if (!customerEmail) {
      console.warn(
        `[StoreEmailService] Skipping pre-order release email (missing customer email). order_id=${order?.id}`,
      );
      return;
    }

    if (order.user_id) {
      const shouldSend = await NotificationUtil.shouldSendNotification(
        order.user_id,
        "email_order_updates",
      );
      if (!shouldSend) {
        console.log(
          `Skipping pre-order release email for user ${order.user_id} based on preferences`,
        );
        return;
      }
    }

    try {
      const emailBody = this.generatePreOrderReleaseEmail(
        order,
        storeName,
        releaseDetails,
      );

      await emailService.send({
        to: customerEmail,
        subject: `Your pre-order is confirmed - ${this.resolveOrderNumber(order)}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Pre-order release email sent to ${customerEmail}`);
    } catch (error) {
      console.error("Failed to send pre-order release email:", error);
    }
  }

  /**
   * Send new order notification to store owner (Platform email)
   */
  async sendNewOrderNotification(
    order: Order,
    storeOwnerEmail: string,
    storeName: string,
    paymentSummary?: PaymentEmailSummary,
  ): Promise<void> {
    // Fetch owner by email — avoids adding ownerId to the public signature for now
    const { data: user } = await supabaseAdmin
      .from("users")
      .select("id")
      .eq("email", storeOwnerEmail)
      .single();

    if (user) {
      const shouldSend = await NotificationUtil.shouldSendNotification(
        user.id,
        "email_new_order",
      );
      if (!shouldSend) {
        console.log(
          `Skipping new order notification for owner ${user.id} based on preferences`,
        );
        return;
      }
    }

    try {
      const emailBody = this.generateNewOrderEmail(
        order,
        storeName,
        paymentSummary,
      );

      await emailService.send({
        to: storeOwnerEmail,
        subject: `🎉 New Order Received - ${order.order_number}`,
        body: emailBody,
        type: "platform",
        forceSenderName: "Hilaq Store",
      });
      console.log(`New order notification sent to ${storeOwnerEmail}`);
    } catch (error) {
      console.error("Failed to send store owner notification:", error);
    }
  }

  /**
   * Generate new order notification email HTML for store owner
   */
  private generateNewOrderEmail(
    order: Order,
    storeName: string,
    paymentSummary?: PaymentEmailSummary,
  ): string {
    const paid = this.resolvePaymentSummary(order, paymentSummary);
    const itemsHtml = paid.items
      .map((item) => {
        const variantDescription = this.formatVariantDescription(item);
        return `
        <tr>
          <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #1e293b;">
            ${item.name}${variantDescription ? ` — ${variantDescription}` : ""}
          </td>
          <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: center; color: #1e293b;">
            ${item.quantity}
          </td>
          <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; color: #1e293b; font-weight: 600;">
            ${formatCurrency(item.unitPrice, paid.currency)}
          </td>
        </tr>
      `;
      })
      .join("");

    return wrapInBaseEmail({
      title: "New Order Received!",
      businessName: "Hilaq Store",
      content: `
        <h1>🎉 New Order!</h1>
        <p>Great news! You've received a new order on <strong>${storeName}</strong>.</p>
        
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Order Info</h3>
          ${emailComponents.infoGroup("Order Number", this.resolveOrderNumber(order))}
          ${emailComponents.infoGroup("Date", new Date(order.created_at).toLocaleDateString())}
        </div>

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Customer</h3>
          ${emailComponents.infoGroup("Name", order.customer_name)}
          ${emailComponents.infoGroup("Email", order.customer_email)}
          ${order.customer_phone ? emailComponents.infoGroup("Phone", order.customer_phone) : ""}
          ${order.customer_address ? emailComponents.infoGroup("Address", order.customer_address) : ""}
        </div>
        
        <table style="width: 100%; border-collapse: collapse; margin-top: 24px;">
          <thead>
            <tr>
              <th style="padding: 12px 0; text-align: left; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 12px; text-transform: uppercase;">Item</th>
              <th style="padding: 12px 0; text-align: center; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 12px; text-transform: uppercase;">Qty</th>
              <th style="padding: 12px 0; text-align: right; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 12px; text-transform: uppercase;">Price</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
            <tr>
              <td colspan="2" style="padding: 12px 0; color: #64748b;">Subtotal</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.subtotal, paid.currency)}</td>
            </tr>
            ${
              paid.discount > 0
                ? `
            <tr>
              <td colspan="2" style="padding: 12px 0; color: #5046E5;">Discount</td>
              <td style="padding: 12px 0; text-align: right; color: #5046E5;">-${formatCurrency(paid.discount, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.deliveryFee > 0
                ? `
            <tr>
              <td colspan="2" style="padding: 12px 0; color: #64748b;">Delivery${(order as any).shipping_carrier ? ` (${(order as any).shipping_carrier})` : ""}</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.deliveryFee, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.tax > 0
                ? `
            <tr>
              <td colspan="2" style="padding: 12px 0; color: #64748b;">Tax</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.tax, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.serviceCharge > 0
                ? `
            <tr>
              <td colspan="2" style="padding: 12px 0; color: #64748b;">Service charge</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.serviceCharge, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            <tr>
              <td colspan="2" style="padding: 16px 0; font-weight: 700; font-size: 18px; color: #1e293b;">Amount paid</td>
              <td style="padding: 16px 0; text-align: right; font-weight: 700; font-size: 18px; color: #5046E5;">${formatCurrency(paid.amount, paid.currency)}</td>
            </tr>
          </tbody>
        </table>
        
        ${emailComponents.button("View Order Details", `https://www.hilaq.com/dashboard/store/order/${order.id}`)}
      `,
    });
  }

  /**
   * Render the store owner's after-purchase note as a "Message from {store}"
   * block. Returns an empty string when no message is set.
   */
  private renderMerchantMessage(
    storeName: string,
    message?: string | null,
  ): string {
    const trimmedMessage = message?.trim();
    if (!trimmedMessage) return "";

    return `
      <div style="margin: 24px 0; border-left: 4px solid #5046E5; background-color: #f8fafc; border-radius: 0 8px 8px 0; padding: 16px;">
        <h3 style="margin: 0 0 8px; font-size: 12px; text-transform: uppercase; color: #64748b;">Message from ${storeName}</h3>
        <p style="margin: 0; color: #1e293b; white-space: pre-line;">${trimmedMessage}</p>
      </div>
    `;
  }

  /**
   * Generate order confirmation email HTML
   */
  private generateOrderConfirmationEmail(
    order: Order,
    storeName: string,
    afterPurchaseMessage?: string | null,
    paymentSummary?: PaymentEmailSummary,
  ): string {
    const paid = this.resolvePaymentSummary(order, paymentSummary);
    const itemsHtml = paid.items
      .map((item) => {
        const variantDescription = this.formatVariantDescription(item);
        return `
        <tr>
          <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; color: #1e293b;">
            ${item.name}${variantDescription ? ` — ${variantDescription}` : ""} (x${item.quantity || 1})
          </td>
          <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0; text-align: right; color: #1e293b; font-weight: 600;">
            ${formatCurrency(item.unitPrice, paid.currency)}
          </td>
        </tr>
      `;
      })
      .join("");

    return wrapInBaseEmail({
      title: `Order Confirmation - ${this.resolveOrderNumber(order)}`,
      businessName: storeName,
      content: `
        <h1>Order Confirmation</h1>
        <p>Hi ${order.customer_name},</p>
        <p>Thank you for your order from <strong>${storeName}</strong>! We're processing it now and will let you know when it's on its way.</p>

        ${this.renderMerchantMessage(storeName, afterPurchaseMessage)}

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          ${emailComponents.infoGroup("Order Number", this.resolveOrderNumber(order))}
          ${emailComponents.infoGroup("Date", new Date(order.created_at).toLocaleDateString())}
        </div>
        
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="padding: 12px 0; text-align: left; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 12px; text-transform: uppercase;">Item</th>
              <th style="padding: 12px 0; text-align: right; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 12px; text-transform: uppercase;">Price</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
            <tr>
              <td style="padding: 12px 0; color: #64748b;">Subtotal</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.subtotal, paid.currency)}</td>
            </tr>
            ${
              paid.discount > 0
                ? `
            <tr>
              <td style="padding: 12px 0; color: #5046E5;">Discount</td>
              <td style="padding: 12px 0; text-align: right; color: #5046E5;">-${formatCurrency(paid.discount, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.tax > 0
                ? `
            <tr>
              <td style="padding: 12px 0; color: #64748b;">Tax</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.tax, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.serviceCharge > 0
                ? `
            <tr>
              <td style="padding: 12px 0; color: #64748b;">Service charge</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.serviceCharge, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            ${
              paid.deliveryFee > 0
                ? `
            <tr>
              <td style="padding: 12px 0; color: #64748b;">Delivery${(order as any).shipping_carrier ? ` (${(order as any).shipping_carrier})` : ""}</td>
              <td style="padding: 12px 0; text-align: right; color: #1e293b;">${formatCurrency(paid.deliveryFee, paid.currency)}</td>
            </tr>
            `
                : ""
            }
            <tr>
              <td style="padding: 16px 0; font-weight: 700; font-size: 18px; color: #1e293b;">Amount paid</td>
              <td style="padding: 16px 0; text-align: right; font-weight: 700; font-size: 18px; color: #5046E5;">${formatCurrency(paid.amount, paid.currency)}</td>
            </tr>
          </tbody>
        </table>
        
        ${
          order.customer_address
            ? `
        <div style="margin: 24px 0; padding-top: 16px; border-top: 1px solid #e2e8f0;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Shipping Address</h3>
          <p style="margin: 0; color: #1e293b;">${order.customer_address}</p>
        </div>
        `
            : ""
        }
        
      <p style="margin-top: 32px; font-size: 14px; color: #64748b;">If you have any questions, please reply to this email. Thank you for shopping with us!</p>
        
        <div style="margin: 32px 0; text-align: center;">
          ${emailComponents.button("View Order & Download Receipt", `https://www.hilaq.com/order-success?reference=${order.payment_reference}`)}
        </div>
      `,
    });
  }

  /**
   * Generate fulfillment email HTML
   */
  private generateFulfillmentEmail(order: Order, storeName: string): string {
    return wrapInBaseEmail({
      title: "Order Fulfilled!",
      businessName: storeName,
      content: `
        <h1>Order Fulfilled! 🎉</h1>
        <p>Hi ${order.customer_name},</p>
        <p>Great news! Your order <strong>${order.order_number}</strong> from <strong>${storeName}</strong> has been fulfilled.</p>
        
        ${
          order.shipping_tracking_number
            ? `
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Tracking Info</h3>
          ${emailComponents.infoGroup("Carrier", order.shipping_carrier || "N/A")}
          ${emailComponents.infoGroup("Tracking Number", order.shipping_tracking_number)}
        </div>
        `
            : ""
        }
        
        <p>Thank you for your business!</p>
      `,
    });
  }

  /**
   * Generate shipping update email HTML
   */
  private generateShippingEmail(order: Order, storeName: string): string {
    return wrapInBaseEmail({
      title: "Shipping Update",
      businessName: storeName,
      content: `
        <h1>Shipping Update 📦</h1>
        <p>Hi ${order.customer_name},</p>
        <p>Your order <strong>${order.order_number}</strong> has been <strong>${order.shipping_status}</strong>.</p>
        
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Details</h3>
          ${emailComponents.infoGroup("Carrier", order.shipping_carrier || "N/A")}
          ${emailComponents.infoGroup("Tracking Number", order.shipping_tracking_number || "N/A")}
          ${emailComponents.infoGroup("Status", order.shipping_status || "N/A")}
        </div>
        
        <p>Thank you for your patience!</p>
      `,
    });
  }

  /**
   * Generate digital product email HTML
   */
  private generateDigitalProductEmail(
    order: Order,
    downloadLinks: string[],
    storeName: string,
  ): string {
    // downloadLinks now contains a single order-success URL
    const accessLink = downloadLinks[0] || "";

    return wrapInBaseEmail({
      title: "Your Digital Products",
      businessName: storeName,
      content: `
        <h1>Your Digital Products 💾</h1>
        <p>Hi ${order.customer_name},</p>
        <p>Your digital products for order <strong>${order.order_number}</strong> are ready to download!</p>
        
        <div style="margin: 32px 0; text-align: center;">
          ${emailComponents.button("Access Your Downloads", accessLink)}
        </div>
        
        <p style="font-size: 14px; color: #64748b; font-style: italic;">Note: You can access your downloads anytime from your order confirmation page.</p>
        <p>Thank you for your purchase!</p>
      `,
    });
  }

  /**
   * Generate pre-order release email HTML
   */
  private generatePreOrderReleaseEmail(
    order: Order,
    storeName: string,
    releaseDetails: { itemNames: string[]; message: string | null },
  ): string {
    const isSingleItem = releaseDetails.itemNames.length === 1;

    const itemsHtml = releaseDetails.itemNames
      .map((name) => `<li style="padding: 4px 0; color: #1e293b;">${name}</li>`)
      .join("");

    const messageHtml = releaseDetails.message
      ? `
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          <p style="margin: 0; color: #1e293b;">${releaseDetails.message}</p>
        </div>
      `
      : "";

    return wrapInBaseEmail({
      title: "Your Pre-order Is Confirmed",
      businessName: storeName,
      content: `
        <h1>Your pre-order is on its way! 🎉</h1>
        <p>Hi ${order.customer_name},</p>
        <p>Good news! The pre-ordered item${isSingleItem ? "" : "s"} below from <strong>${storeName}</strong> ${isSingleItem ? "is" : "are"} now available and being prepared for shipping.</p>

        <ul style="margin: 16px 0; padding-left: 20px;">
          ${itemsHtml}
        </ul>

        ${messageHtml}

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          ${emailComponents.infoGroup("Order Number", this.resolveOrderNumber(order))}
        </div>

        <p>We'll send you another update once it ships. Thank you for your patience!</p>

        <div style="margin: 32px 0; text-align: center;">
          ${emailComponents.button("View Your Order", `https://www.hilaq.com/order-success?reference=${order.payment_reference}`)}
        </div>
      `,
    });
  }

  /**
   * Send booking confirmation email
   */
  async sendBookingConfirmation(
    booking: ServiceBooking,
    storeName: string,
    businessId?: string,
    calendarLinks?: { googleCalendarUrl: string; icsUrl: string },
  ): Promise<void> {
    if (!booking.customer_email) {
      console.warn(
        `[StoreEmailService] Skipping booking confirmation (missing customer email). booking_id=${booking?.id}`,
      );
      return;
    }

    try {
      const emailBody = this.generateBookingConfirmationEmail(booking, storeName, calendarLinks);

      await emailService.send({
        to: booking.customer_email,
        subject: `Booking Confirmed - ${storeName}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(
        `Booking confirmation email sent to ${booking.customer_email}`,
      );
    } catch (error) {
      console.error("Failed to send booking confirmation email:", error);
    }
  }

  /**
   * Send booking declined email
   */
  async sendBookingDecline(
    booking: ServiceBooking,
    storeName: string,
    reason?: string,
    businessId?: string,
  ): Promise<void> {
    if (!booking.customer_email) {
      console.warn(
        `[StoreEmailService] Skipping booking decline (missing customer email). booking_id=${booking?.id}`,
      );
      return;
    }

    try {
      const emailBody = this.generateBookingDeclineEmail(
        booking,
        storeName,
        reason,
      );

      await emailService.send({
        to: booking.customer_email,
        subject: `Booking Update - ${storeName}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(`Booking decline email sent to ${booking.customer_email}`);
    } catch (error) {
      console.error("Failed to send booking decline email:", error);
    }
  }

  /**
   * Generate booking confirmation email HTML
   */
  private generateBookingConfirmationEmail(
    booking: ServiceBooking,
    storeName: string,
    calendarLinks?: { googleCalendarUrl: string; icsUrl: string },
  ): string {
    const productName = (booking as any).product?.name || "Service";
    const date = new Date(booking.booking_date).toLocaleDateString();

    const calendarSection = calendarLinks
      ? `
        <div style="margin: 20px 0;">
          <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 0 0 10px;">
            <tr>
              <td style="border-radius: 100px; background-color: #1a73e8;">
                <a href="${calendarLinks.googleCalendarUrl}" target="_blank" style="display: inline-block; padding: 10px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 100px;">
                  Add to Google Calendar
                </a>
              </td>
            </tr>
          </table>
          <p style="margin: 0; font-size: 12px; color: #64748b;">
            <a href="${calendarLinks.icsUrl}" style="color: #64748b; text-decoration: underline;">Download .ics (Apple Calendar / Outlook)</a>
          </p>
        </div>`
      : "";

    return wrapInBaseEmail({
      title: "Booking Confirmed",
      businessName: storeName,
      content: `
        <h1>Booking Confirmed! ✅</h1>
        <p>Hi ${booking.customer_name || "Customer"},</p>
        <p>Your booking with <strong>${storeName}</strong> has been confirmed.</p>

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Booking Details</h3>
          ${emailComponents.infoGroup("Service", productName)}
          ${emailComponents.infoGroup("Date", date)}
          ${emailComponents.infoGroup("Time", `${booking.start_time} - ${booking.end_time}`)}
          ${booking.location_type ? emailComponents.infoGroup("Location", booking.location_type === "zoom" ? "Zoom Meeting" : booking.location_type) : ""}
          ${booking.location_details ? emailComponents.infoGroup("Location Details", `<a href="${booking.location_details}">${booking.location_details}</a>`) : ""}
        </div>

        ${calendarSection}

        <p>We look forward to seeing you!</p>

        <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
          <p>Need to reschedule? Please contact the store directly.</p>
        </div>
      `,
    });
  }

  /**
   * Generate booking decline email HTML
   */
  private generateBookingDeclineEmail(
    booking: ServiceBooking,
    storeName: string,
    reason?: string,
  ): string {
    const productName = (booking as any).product?.name || "Service";
    const date = new Date(booking.booking_date).toLocaleDateString();

    return wrapInBaseEmail({
      title: "Booking Update",
      businessName: storeName,
      content: `
        <h1>Booking Declined</h1>
        <p>Hi ${booking.customer_name || "Customer"},</p>
        <p>Unfortunately, your booking request for <strong>${storeName}</strong> could not be accommodated at this time.</p>
        
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Details</h3>
          ${emailComponents.infoGroup("Service", productName)}
          ${emailComponents.infoGroup("Date", date)}
          ${emailComponents.infoGroup("Time", `${booking.start_time} - ${booking.end_time}`)}
        </div>

        ${
          reason
            ? `
        <div style="margin: 24px 0; padding: 16px; background-color: #fff1f2; border-radius: 8px; border: 1px solid #fecdd3;">
          <strong>Reason:</strong><br>
          ${reason}
        </div>
        `
            : ""
        }
        
        <p>Any payment made has been processed for refund (if applicable).</p>
      `,
    });
  }

  /**
   * Send booking request received email
   */
  async sendBookingRequestReceived(
    booking: ServiceBooking,
    storeName: string,
    businessId?: string,
  ): Promise<void> {
    const emailBody = this.generateBookingRequestReceivedEmail(
      booking,
      storeName,
    );

    try {
      if (!booking.customer_email) return;

      await emailService.send({
        to: booking.customer_email,
        subject: `Booking Request Received - ${storeName}`,
        body: emailBody,
        type: businessId ? "business" : "platform",
        businessId,
        forceSenderName: storeName,
      });
      console.log(
        `Booking request received email sent to ${booking.customer_email}`,
      );
    } catch (error) {
      console.error("Failed to send booking request received email:", error);
    }
  }

  /**
   * Generate booking request received email HTML
   */
  private generateBookingRequestReceivedEmail(
    booking: ServiceBooking,
    storeName: string,
  ): string {
    const productName = (booking as any).product?.name || "Service";
    const date = new Date(booking.booking_date).toLocaleDateString();

    return wrapInBaseEmail({
      title: "Booking Request Received",
      businessName: storeName,
      content: `
        <h1>Booking Request Received ⏳</h1>
        <p>Hi ${booking.customer_name || "Customer"},</p>
        <p>Your booking request for <strong>${storeName}</strong> has been received.</p>
        <p>The store owner will review your request and you will receive a confirmation email once it is approved.</p>
        
        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          <h3 style="margin-top: 0; font-size: 14px; text-transform: uppercase; color: #64748b;">Request Details</h3>
          ${emailComponents.infoGroup("Service", productName)}
          ${emailComponents.infoGroup("Date", date)}
          ${emailComponents.infoGroup("Time", `${booking.start_time} - ${booking.end_time}`)}
          ${booking.location_type ? emailComponents.infoGroup("Location", booking.location_type === "zoom" ? "Zoom Meeting" : booking.location_type) : ""}
        </div>
        
        <p>Thank you for your patience!</p>
      `,
    });
  }

  /**
   * Send a purchase order to a supplier. Returns whether the email actually
   * went out — callers use this to decide whether "sent" is honest (the
   * order is still marked sent either way, matching how every other
   * transactional email here never blocks its primary action; the return
   * value just lets the caller tell the merchant if delivery failed).
   */
  async sendPurchaseOrderEmail(params: {
    supplierEmail: string;
    supplierName: string;
    storeName: string;
    businessId?: string;
    orderNumber: string;
    orderDate: string;
    expectedDeliveryDate?: string | null;
    locationName?: string | null;
    notes?: string | null;
    currency: string;
    lines: Array<{ description: string; quantity: number; unitCost: number; total: number }>;
    subtotal: number;
    tax: number;
    total: number;
  }): Promise<boolean> {
    try {
      await emailService.send({
        to: params.supplierEmail,
        subject: `Purchase order ${params.orderNumber} from ${params.storeName}`,
        body: this.generatePurchaseOrderEmail(params),
        type: params.businessId ? "business" : "platform",
        businessId: params.businessId,
        forceSenderName: params.storeName,
      });
      console.log(`Purchase order email sent to ${params.supplierEmail}`);
      return true;
    } catch (error) {
      console.error("Failed to send purchase order email:", error);
      return false;
    }
  }

  /**
   * Generate purchase order email HTML
   */
  private generatePurchaseOrderEmail(params: {
    supplierName: string;
    storeName: string;
    orderNumber: string;
    orderDate: string;
    expectedDeliveryDate?: string | null;
    locationName?: string | null;
    notes?: string | null;
    currency: string;
    lines: Array<{ description: string; quantity: number; unitCost: number; total: number }>;
    subtotal: number;
    tax: number;
    total: number;
  }): string {
    const money = (value: number) => formatCurrency(value, params.currency);
    const formatDate = (value: string) =>
      new Date(value).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });

    const rows = params.lines
      .map(
        (line) => `
        <tr>
          <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #1e293b;">${line.description}</td>
          <td align="center" style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #64748b;">${line.quantity}</td>
          <td align="right" style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #64748b;">${money(line.unitCost)}</td>
          <td align="right" style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; font-size: 14px; color: #1e293b; font-weight: 600;">${money(line.total)}</td>
        </tr>`,
      )
      .join("");

    return wrapInBaseEmail({
      title: `Purchase order ${params.orderNumber}`,
      previewText: `New purchase order from ${params.storeName}`,
      businessName: params.storeName,
      content: `
        <h1 style="color: #111827;">Purchase order ${params.orderNumber}</h1>
        <p>Hi ${params.supplierName}, ${params.storeName} has placed a new purchase order with you. Details below.</p>

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          ${emailComponents.infoGroup("Order date", formatDate(params.orderDate))}
          ${params.expectedDeliveryDate ? emailComponents.infoGroup("Expected delivery", formatDate(params.expectedDeliveryDate)) : ""}
          ${params.locationName ? emailComponents.infoGroup("Deliver to", params.locationName) : ""}
        </div>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin: 24px 0; border-collapse: collapse;">
          <thead>
            <tr>
              <th align="left" style="padding-bottom: 8px; border-bottom: 2px solid #111827; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;">Item</th>
              <th align="center" style="padding-bottom: 8px; border-bottom: 2px solid #111827; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;">Qty</th>
              <th align="right" style="padding-bottom: 8px; border-bottom: 2px solid #111827; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;">Unit cost</th>
              <th align="right" style="padding-bottom: 8px; border-bottom: 2px solid #111827; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b;">Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" style="margin: 8px 0 24px;">
          <tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Subtotal</td>
            <td align="right" style="padding: 4px 0; font-size: 14px; color: #1e293b;">${money(params.subtotal)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; font-size: 14px; color: #64748b;">Tax</td>
            <td align="right" style="padding: 4px 0; font-size: 14px; color: #1e293b;">${money(params.tax)}</td>
          </tr>
          <tr>
            <td style="padding: 8px 0; font-size: 16px; font-weight: 700; color: #111827; border-top: 1px solid #e2e8f0;">Total</td>
            <td align="right" style="padding: 8px 0; font-size: 16px; font-weight: 700; color: #111827; border-top: 1px solid #e2e8f0;">${money(params.total)}</td>
          </tr>
        </table>

        ${params.notes ? `<p style="font-size: 14px; color: #64748b;"><strong>Notes:</strong> ${params.notes}</p>` : ""}

        <p style="color: #64748b; font-size: 14px; margin-top: 32px;">Please reply to this email if you have any questions about this order.</p>
      `,
    });
  }

  /**
   * Sent to every approver on a newly-gated bill/transfer's first pending
   * step (see ApprovalWorkflowService.gateSubmission) — otherwise the only
   * way anyone finds out something needs their sign-off is by remembering
   * to open Payments > Approvals. Best-effort: a failed send here should
   * never block the submission that triggered it.
   */
  async sendApprovalRequestedEmail(params: {
    approverEmail: string;
    approverName: string;
    businessId?: string;
    businessName: string;
    workflowName: string;
    subjectLabel: string; // e.g. "Bill INV-3680 — Lekki Fresh Produce Ltd"
    isTransfer: boolean; // true = "bill_transfer" (moves real money on approval)
    amount: number;
    currency: string;
    requestedByLabel: string; // name or email of whoever submitted it
  }): Promise<boolean> {
    try {
      const kind = params.isTransfer ? "vendor payment" : "bill";
      await emailService.send({
        to: params.approverEmail,
        subject: `Action needed: ${params.subjectLabel} needs your approval`,
        body: this.generateApprovalRequestedEmail(params, kind),
        type: params.businessId ? "business" : "platform",
        businessId: params.businessId,
        forceSenderName: params.businessName,
      });
      return true;
    } catch (error) {
      console.error("Failed to send approval-requested email:", error);
      return false;
    }
  }

  private generateApprovalRequestedEmail(
    params: {
      approverName: string;
      businessName: string;
      workflowName: string;
      subjectLabel: string;
      isTransfer: boolean;
      amount: number;
      currency: string;
      requestedByLabel: string;
    },
    kind: string,
  ): string {
    const money = formatCurrency(params.amount, params.currency);
    return wrapInBaseEmail({
      title: `${params.subjectLabel} needs your approval`,
      previewText: `${money} is waiting on your sign-off at ${params.businessName}`,
      businessName: params.businessName,
      content: `
        <h1 style="color: #111827;">You have a ${kind} to review</h1>
        <p>Hi ${params.approverName}, ${params.requestedByLabel} submitted the following at ${params.businessName}. It won't ${
          params.isTransfer ? "move any money" : "move forward"
        } until you (and anyone else required) approve it.</p>

        <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; background-color: #f8fafc;">
          ${emailComponents.infoGroup(params.isTransfer ? "Vendor payment" : "Bill", params.subjectLabel)}
          ${emailComponents.infoGroup("Amount", money)}
          ${emailComponents.infoGroup("Workflow", params.workflowName)}
        </div>

        ${emailComponents.button("Review and decide", "https://www.hilaq.com/dashboard?tab=home&homeTab=needs-attention")}

        ${
          params.isTransfer
            ? `<p style="color: #64748b; font-size: 14px;">The wallet has already been debited and is holding the funds — approving releases them to the vendor immediately; rejecting returns them to the wallet.</p>`
            : ""
        }
      `,
    });
  }
}

export const storeEmailService = new StoreEmailService();
