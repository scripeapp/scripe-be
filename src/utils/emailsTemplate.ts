import { wrapInBaseEmail, emailComponents } from "./email/BaseEmail";
import type { EventPaymentSummary } from "../types/webhook";

const formatEventPaymentAmount = (
  summary: EventPaymentSummary,
  amount: number,
) =>
  new Intl.NumberFormat("en", {
    style: "currency",
    currency: summary.currency,
  }).format(amount);

const renderEventDiscounts = (summary: EventPaymentSummary): string => {
  if (summary.discounts?.length) {
    return summary.discounts
      .map((discount) => {
        const label = discount.coupon_code
          ? `Discount (${discount.coupon_code})`
          : discount.message
            ? `Discount — ${discount.message}`
            : "Discount";
        return emailComponents.infoGroup(
          label,
          `-${formatEventPaymentAmount(summary, discount.amount)}`,
        );
      })
      .join("");
  }
  return summary.discount > 0
    ? emailComponents.infoGroup(
        "Discount",
        `-${formatEventPaymentAmount(summary, summary.discount)}`,
      )
    : "";
};

/**
 * Transform rich-text HTML (TipTap / ProseMirror / Draft.js) into email-safe HTML.
 *
 * Email clients (Gmail, Outlook, Yahoo) strip <style> blocks and reset element
 * margins to 0.  Every visual property MUST be an inline style on the element.
 *
 * Key rules:
 *  - Empty <p> → visible spacer line (not deleted) — editors use these for blank lines
 *  - All block elements → inline margin / line-height
 *  - Elements that already carry a style attr are left untouched to avoid conflicts
 *  - 4+ consecutive <br> → collapsed to two (intentional double-breaks kept)
 */
export const sanitizeEditorHtml = (html: string): string =>
  html
    // ── Blank lines ──────────────────────────────────────────────────────────
    // Convert empty <p> elements to visible spacer lines instead of deleting
    // them. Editors use empty paragraphs for intentional blank lines; removing
    // them collapses everything into a wall of text.
    .replace(
      /<p[^>]*>\s*(?:<br\s*\/?>)?\s*<\/p>/gi,
      '<p style="margin:0;padding:0;line-height:16px;font-size:16px;">&nbsp;</p>',
    )

    // ── Paragraphs ────────────────────────────────────────────────────────────
    // Only inject styles on <p> tags that don't already carry a style attr
    // (our spacers above already have one, so they are skipped here).
    .replace(
      /<p(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<p style="margin:0 0 16px;padding:0;line-height:1.7;"$1>',
    )

    // ── Headings ──────────────────────────────────────────────────────────────
    .replace(
      /<h1(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<h1 style="font-size:22px;font-weight:700;line-height:1.3;margin:0 0 12px;padding:0;"$1>',
    )
    .replace(
      /<h2(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<h2 style="font-size:18px;font-weight:700;line-height:1.35;margin:0 0 10px;padding:0;"$1>',
    )
    .replace(
      /<h3(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<h3 style="font-size:16px;font-weight:600;line-height:1.4;margin:0 0 8px;padding:0;"$1>',
    )

    // ── Lists ─────────────────────────────────────────────────────────────────
    .replace(
      /<ul(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<ul style="margin:0 0 16px;padding-left:24px;"$1>',
    )
    .replace(
      /<ol(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<ol style="margin:0 0 16px;padding-left:24px;"$1>',
    )
    .replace(
      /<li(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<li style="margin-bottom:6px;line-height:1.65;"$1>',
    )

    // ── Block quotes ──────────────────────────────────────────────────────────
    .replace(
      /<blockquote(?![^>]*\bstyle\b)([^>]*)>/gi,
      '<blockquote style="border-left:3px solid #5046e5;margin:0 0 16px;padding:8px 16px;color:#475569;"$1>',
    )

    // ── Line-break overflow ───────────────────────────────────────────────────
    // Collapse 4+ consecutive <br> into two — keep intentional double line-breaks.
    .replace(/(<br\s*\/?\s*>){4,}/gi, "<br><br>")

    .trim();

export const postNotificationMailToSubscribers = (data: {
  name: string;
  author_name: string;
  pub_name: string;
  post_title: string;
  post_subtitle: string;
  post_content: string;
  post_id: string | number;
  cover_image?: string | null;
}): string => {
  const date = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  return wrapInBaseEmail({
    title: data.post_title,
    previewText: data.post_subtitle,
    businessName: data.pub_name,
    hideLogo: true,
    variant: "editorial",
    content: `
    ${
      data.cover_image && !data.cover_image.startsWith("blob:")
        ? `
    <div style="margin-bottom: 32px;border-radius:8px;overflow:hidden;">
      <img src="${data.cover_image}" alt="${data.post_title}" style="width:100%;max-height:400px;object-fit:cover;display:block;border-radius:8px;" />
    </div>
    `
        : ""
    }
    <div style="margin-bottom: 40px;">
      <div style="font-family: 'Inter', sans-serif; font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #5046e5; margin-bottom: 16px;">
        NEW POST <span style="color: #64748b; margin: 0 4px;">&middot;</span> ${data.pub_name.toUpperCase()}
      </div>

      <h1 style="margin-bottom: 12px;">${data.post_title}</h1>

      <p style="font-size: 20px; color: #4a4a47; margin-top: 0; margin-bottom: 24px; line-height: 1.5; font-style: normal;">
        ${data.post_subtitle}
      </p>

      <div style="display: flex; align-items: center; gap: 12px; padding: 16px 0; border-top: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; margin-bottom: 32px;">
        <div style="flex: 1;">
          <div style="font-family: 'Inter', sans-serif; font-size: 13px; font-weight: 600; color: #1a1a18; margin-bottom: 2px;">
            ${data.author_name}
          </div>
          <div style="font-family: 'Inter', sans-serif; font-size: 12px; color: #8c8b87;">
            ${date}
          </div>
        </div>
      </div>
    </div>
    
    <div class="article-body-content" style="font-family: 'Times New Roman', Times, serif; font-size: 18px; line-height: 1.8; color: #1a1a18;">
      ${sanitizeEditorHtml(data.post_content)}
    </div>

    <div style="margin-top: 48px; text-align: center;">
      <div style="text-align: center; margin: 24px 0; letter-spacing: 0.5em; color: #5046E5; font-weight: bold;">&middot; &middot; &middot;</div>
      ${emailComponents.button("Read the full article", `https://www.hilaq.com/posts/${data.post_id}`)}
    </div>
  `,
  });
};

export const eventTicketReceiptCustomer = (params: {
  ticketId: string | number;
  eventName: string;
  eventDate: string;
  venue: string;
  registrationNumber?: number | null;
  customMessage?: string;
  googleCalendarUrl?: string | null;
  icsUrl?: string | null;
  dateTbd?: boolean;
  paymentSummary?: EventPaymentSummary;
}): string => {
  const { ticketId, eventName, eventDate, venue, registrationNumber, customMessage, googleCalendarUrl, icsUrl, dateTbd, paymentSummary } = params;

  const paymentSection = paymentSummary
    ? `
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; margin: 24px 0;">
      <h3 style="margin: 0 0 12px; font-size: 14px; text-transform: uppercase; color: #64748b;">Payment summary</h3>
      ${emailComponents.infoGroup("Subtotal", formatEventPaymentAmount(paymentSummary, paymentSummary.subtotal))}
      ${renderEventDiscounts(paymentSummary)}
      ${paymentSummary.surcharge > 0 ? emailComponents.infoGroup("Additional charges", formatEventPaymentAmount(paymentSummary, paymentSummary.surcharge)) : ""}
      ${paymentSummary.coupon_applied && paymentSummary.coupon_code && !paymentSummary.discounts?.some((discount) => discount.coupon_code) ? emailComponents.infoGroup("Coupon", paymentSummary.coupon_code) : ""}
      ${emailComponents.infoGroup("Amount paid", formatEventPaymentAmount(paymentSummary, paymentSummary.amount))}
    </div>`
    : "";

  const merchantSection = customMessage?.trim()
    ? `
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; margin: 24px 0;">
      ${emailComponents.infoGroup("A note from the organiser", customMessage)}
    </div>`
    : "";

  // When the event date is not set yet (TBD) there is no calendar link to
  // offer — replace the buttons with a short note so buyers are not left
  // wondering where the date went.
  const dateTbdNotice = dateTbd
    ? `
    <div style="margin: 20px 0; padding: 14px 18px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; font-size: 13px; color: #92400e; line-height: 1.5;">
      <strong>Event Dates to be Disclosed</strong> — the organiser hasn't announced the date yet. Check back on the event page for updates.
    </div>`
    : "";

  const calendarSection = !dateTbd && googleCalendarUrl
    ? `
    <div style="margin: 20px 0;">
      <table border="0" cellpadding="0" cellspacing="0" role="presentation" style="margin: 0 0 10px;">
        <tr>
          <td style="border-radius: 100px; background-color: #1a73e8;">
            <a href="${googleCalendarUrl}" target="_blank" style="display: inline-block; padding: 10px 22px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; font-weight: 600; color: #ffffff; text-decoration: none; border-radius: 100px;">
              Add to Google Calendar
            </a>
          </td>
        </tr>
      </table>
      ${icsUrl ? `<p style="margin: 0; font-size: 12px; color: #64748b;"><a href="${icsUrl}" style="color: #64748b; text-decoration: underline;">Download .ics (Apple Calendar / Outlook)</a></p>` : ""}
    </div>`
    : "";

  return wrapInBaseEmail({
    title: "Your Order Confirmation",
    businessName: "Hilaq Events",
    content: `
    <h1 style="margin-bottom: 4px;">You're going to ${eventName}!</h1>
    <p style="margin-top: 0; color: #64748b;">Your ticket purchase is confirmed.</p>

    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 20px 24px; margin: 24px 0;">
      ${emailComponents.infoGroup("Event", eventName)}
      ${emailComponents.infoGroup("Date & Time", eventDate)}
      ${emailComponents.infoGroup("Venue", venue)}
      ${registrationNumber != null ? emailComponents.infoGroup("Registration #", String(registrationNumber)) : ""}
    </div>

    ${paymentSection}

    ${emailComponents.button("View Your Ticket", `https://www.hilaq.com/orders/receipt/${ticketId}`)}

    ${dateTbd ? dateTbdNotice : calendarSection}

    ${merchantSection}

    <p style="font-size: 13px; color: #64748b; margin: 24px 0 0;"><strong>Note:</strong> This email is your proof of purchase. Keep it handy — you can view and download your ticket at any time from the link above.</p>
    <p>If you have any questions about your order, please contact our support team at <a href="mailto:support@hilaq.com">support@hilaq.com</a>.</p>
  `,
  });
};

export const eventTicketVendorNotification = (data: {
  amount: number;
  currency: string;
  vendorName: string;
  eventID: string | number;
  eventName: string;
  buyerName: string;
  dataTime: string;
  quantity: number | string;
  paymentSummary?: EventPaymentSummary;
}): string =>
  wrapInBaseEmail({
    title: "New Ticket Sale!",
    businessName: "Hilaq Events",
    content: `
    <h1>🎉 New Ticket Sale!</h1>
    <p>Dear ${data.vendorName},</p>
    <p>Great news — you’ve just made a new ticket sale for <strong>${data.eventName}</strong>.</p>
    
    <div style="margin: 24px 0; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
      <div style="padding: 16px; background-color: #f8fafc; border-bottom: 1px solid #e2e8f0; font-weight: 600;">Order Details</div>
      <div style="padding: 16px;">
        ${emailComponents.infoGroup("Quantity", data.quantity.toString())}
        ${data.paymentSummary ? emailComponents.infoGroup("Subtotal", formatEventPaymentAmount(data.paymentSummary, data.paymentSummary.subtotal)) : ""}
        ${data.paymentSummary ? renderEventDiscounts(data.paymentSummary) : ""}
        ${data.paymentSummary && data.paymentSummary.surcharge > 0 ? emailComponents.infoGroup("Additional charges", formatEventPaymentAmount(data.paymentSummary, data.paymentSummary.surcharge)) : ""}
        ${data.paymentSummary?.coupon_applied && data.paymentSummary.coupon_code && !data.paymentSummary.discounts?.some((discount) => discount.coupon_code) ? emailComponents.infoGroup("Coupon", data.paymentSummary.coupon_code) : ""}
        ${emailComponents.infoGroup(
          "Amount paid",
          new Intl.NumberFormat("en", {
            style: "currency",
            currency: data.currency,
          }).format(data.amount),
        )}
        ${emailComponents.infoGroup("Buyer", data.buyerName)}
        ${emailComponents.infoGroup("Time", data.dataTime)}
      </div>
    </div>

    ${emailComponents.button("Go to Dashboard", `https://www.hilaq.com/dashboard/events/${data.eventID}`)}
    <p>Keep up the amazing work — your event is gaining traction!</p>
  `,
  });

export const newCommentNotification = (data: {
  creator_name: string;
  commenter_name: string;
  post_preview: string;
  comment_text: string;
  post_url: string;
  unsubscribe_url: string;
}): string =>
  wrapInBaseEmail({
    title: "New Comment on Your Post",
    content: `
    <h1>New Comment</h1>
    <p>Dear ${data.creator_name},</p>
    <p><strong>${data.commenter_name}</strong> commented on your post: "${data.post_preview || "..."}"</p>
    <div style="border-left: 4px solid #5046E5; padding: 12px 16px; background-color: #f8fafc; font-style: italic; margin: 24px 0;">
      "${data.comment_text}"
    </div>
    ${emailComponents.button("Reply to Comment", data.post_url)}
  `,
    footerContent: `<a href="${data.unsubscribe_url}" class="muted">Unsubscribe from these notifications</a>`,
  });

export const newLikeNotification = (data: {
  creator_name: string;
  liker_name: string;
  post_preview: string;
  post_url: string;
  unsubscribe_url: string;
}): string =>
  wrapInBaseEmail({
    title: "Someone liked your post",
    content: `
    <h1>New Like</h1>
    <p>Dear ${data.creator_name},</p>
    <p><strong>${data.liker_name}</strong> liked your post: "${data.post_preview || "..."}"</p>
    <p>It's great to see your work being appreciated!</p>
    ${emailComponents.button("View Post", data.post_url)}
  `,
    footerContent: `<a href="${data.unsubscribe_url}" class="muted">Unsubscribe from these notifications</a>`,
  });

export const newSignupNotification = ({ name }: { name: string }): string =>
  wrapInBaseEmail({
    title: "Welcome to Hilaq!",
    content: `
    <h1>Welcome aboard, ${name}!</h1>
    <p>We're thrilled to have you join our community of learners, creators, and knowledge seekers.</p>
    <p>Get started by exploring topics that interest you, following your favorite creators, or publishing your own insights.</p>
    ${emailComponents.button("Explore Hilaq", "https://www.hilaq.com")}
    <p>If you have any questions, simply reply to this email or contact <a href="mailto:support@hilaq.com">support@hilaq.com</a>.</p>
  `,
  });

export const verificationEmail = (data: {
  name: string;
  verificationLink: string;
}): string =>
  wrapInBaseEmail({
    title: "Verify Your Email - Hilaq",
    previewText: "Please verify your email to complete your Hilaq registration",
    content: `
    <h1>Welcome to Hilaq, ${data.name}!</h1>
    <p>Thank you for signing up. To complete your registration and start exploring, please verify your email address by clicking the button below.</p>
    ${emailComponents.button("Verify Email Address", data.verificationLink)}
    <div style="background-color: #f8fafc; padding: 20px; border-radius: 8px; margin: 24px 0;">
      <p style="margin: 0; font-size: 14px; color: #64748b;">
        <strong>Note:</strong> This verification link will expire in 24 hours. If you didn't create an account with Hilaq, you can safely ignore this email.
      </p>
    </div>
    <p>If you have trouble clicking the button, copy and paste this link into your browser:</p>
    <p style="word-break: break-all; font-size: 14px; color: #64748b;">${data.verificationLink}</p>
  `,
  });

export const welcomeEmail = (data: { name: string }): string =>
  wrapInBaseEmail({
    title: "Welcome to Hilaq!",
    previewText: "A personal note from Abdulsalam, CEO of Hilaq",
    content: `
    <div style="margin-bottom: 32px; text-align: center;">
      <img src="https://www.hilaq.com/hilaq-banner-image.png" alt="Welcome to Hilaq" style="width: 100%; max-width: 600px; height: auto; border-radius: 12px; display: block;" />
    </div>

    <p>Hello ${data.name},</p>

    <p>I'm Abdulsalam, CEO at Hilaq, and I'm really excited you've joined us.</p>

    <p>We built Hilaq with a clear purpose: to help you manage professional business operations with ease.</p>
    
    <p>Our aim is to provide creators, educators, and entrepreneurs like you with one unified platform where you can grow your brand, scale meaningful ideas, and receive payments—without the complexity of managing multiple tools.</p>

    <p>Here's what you now have access to:</p>

    <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0;">
      <div style="margin-bottom: 16px;">
        <p style="margin: 0; font-weight: 600; color: #1e293b;">🛍️ Store</p>
        <p style="margin: 4px 0 0; color: #64748b; font-size: 15px;">Sell physical products, digital downloads, and courses all in one place. Accept payments and manage your orders with ease.</p>
      </div>
      <div style="margin-bottom: 16px;">
        <p style="margin: 0; font-weight: 600; color: #1e293b;">🎟️ Events</p>
        <p style="margin: 4px 0 0; color: #64748b; font-size: 15px;">Host paid or free events, sell tickets, and manage registrations seamlessly whether in person or online. Every event is another touchpoint to grow your brand.</p>
      </div>
      <div>
        <p style="margin: 0; font-weight: 600; color: #1e293b;">📰 Newsletter</p>
        <p style="margin: 4px 0 0; color: #64748b; font-size: 15px;">Write, publish, and monetise your ideas. Build a loyal subscriber base, share your expertise, and establish yourself as the leading voice in your field.</p>
      </div>
    </div>

    <p>Whether you're just starting out or scaling something big, Hilaq gives you everything you need to build your brand and turn your ideas into real income.</p>

    ${emailComponents.button("Open Hilaq", "https://www.hilaq.com")}

    <p>We're thrilled to have you on board. I can't wait to see what you'll build on Hilaq.</p>

    <p style="margin-bottom: 4px;">Warm regards,</p>
    <p style="margin-top: 0; font-weight: 600; color: #1e293b;">Abdulsalam<br><span style="font-weight: 400; color: #64748b; font-size: 15px;">CEO, Hilaq</span></p>
  `,
  });

export const activationNudgeEmail = (data: {
  previewText: string;
  title: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  bullets?: string[];
}): string =>
  wrapInBaseEmail({
    title: data.title,
    previewText: data.previewText,
    businessName: "Hilaq",
    content: `
      <h1>${data.title}</h1>
      <p>${data.body}</p>
      ${
        data.bullets?.length
          ? `<div style="background-color: #f8fafc; padding: 20px; border-radius: 12px; margin: 24px 0;">
              <ul style="padding-left: 20px; margin: 0;">
                ${data.bullets
                  .map(
                    (bullet) =>
                      `<li style="margin-bottom: 10px; color: #475569;">${bullet}</li>`,
                  )
                  .join("")}
              </ul>
            </div>`
          : ""
      }
      ${emailComponents.button(data.ctaLabel, data.ctaUrl)}
    `,
  });

export const newSubscriberNotification = (data: {
  creator_name: string;
  subscriber_name: string;
  publication_name: string;
  profile_url: string;
  unsubscribe_url: string;
}): string =>
  wrapInBaseEmail({
    title: "New Subscriber!",
    content: `
    <h1>Audience Growth</h1>
    <p>Dear ${data.creator_name},</p>
    <p>Great news! <strong>${data.subscriber_name}</strong> just subscribed to <strong>${data.publication_name}</strong>.</p>
    ${emailComponents.button("View Subscriber Profile", data.profile_url)}
    <p>Your audience is growing. Keep sharing your valuable insights!</p>
  `,
    footerContent: `<a href="${data.unsubscribe_url}" class="muted">Unsubscribe from these notifications</a>`,
  });

export const tippingConfirmationEmail = (data: {
  userName: string;
  recipientName: string;
}): string =>
  wrapInBaseEmail({
    title: "Your tip has been sent successfully!",
    content: `
    <h1>Thank you for your generosity!</h1>
    <p>Dear ${data.userName},</p>
    <p>Your tip has been successfully sent to <strong>${data.recipientName}</strong> for their insightful content and participation.</p>
    <p>Supporting each other strengthens our learning community and encourages more high-quality contributions. We appreciate members like you who acknowledge and reward valuable insights shared on our platform.</p>
    <p>Keep engaging with our community of learners!</p>
  `,
  });

export const membershipWelcomeEmail = (data: {
  userName: string;
  planId?: string;
}): string => {
  const isPro = data.planId?.toLowerCase() === "pro";
  const planName = isPro ? "Pro" : "Plus";

  const features = isPro
    ? `
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">🚀 Scalability Without Limits</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Enjoy unlimited products, website pages, sessions, and team members. Focus on growth, not limits.</div>
        </div>
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">🎓 Advanced Monetization</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Launch comprehensive Courses and recurring Memberships to build a sustainable revenue stream.</div>
        </div>
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">🌐 Professional Branding</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Establish trust with a Custom Domain and gain deep insights with Advanced Analytics.</div>
        </div>
        <div>
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">⭐ VIP Support</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Get your questions answered faster with Priority Support from our dedicated team.</div>
        </div>
      `
    : `
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">✨ Established Presence</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Expand your reach with 2 newsletters, 50 products, and a professional 10-page website.</div>
        </div>
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">📅 Services & Bookings</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Streamline your operations with 10 active sessions and integrated booking management.</div>
        </div>
        <div style="margin-bottom: 20px;">
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">👥 Community Growth</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Manage up to 1,000 CRM contacts and collaborate with 3 team members.</div>
        </div>
        <div>
          <div style="margin: 0; font-weight: 600; color: #5046E5; font-size: 16px;">🛠️ Advanced Tools</div>
          <div style="margin: 4px 0 0; color: #475569; font-size: 15px; line-height: 1.5;">Unlock the Advanced Page Builder to create stunning, high-converting layouts.</div>
        </div>
      `;

  return wrapInBaseEmail({
    title: `Welcome to Hilaq ${planName}`,
    previewText: `Your ${planName} journey begins today`,
    content: `
    <h1 style="color: #111827;">Unlock Your Full Potential with Hilaq ${planName}</h1>
    <p>Welcome aboard, ${data.userName}. We're thrilled to have you join our community of dedicated creators and high-achievers.</p>
    
    <div style="background-color: #f8fafc; padding: 28px; border-radius: 16px; border: 1px solid #e2e8f0; margin: 32px 0;">
      <h3 style="margin-top: 0; font-size: 18px; color: #111827; font-weight: 700;">Your ${planName} Advantage</h3>
      
      <div style="margin-top: 20px;">
        ${features}
      </div>
    </div>

    <div style="text-align: center; margin: 32px 0;">
      ${emailComponents.button("Explore Your Dashboard", "https://app.hilaq.com/dashboard")}
    </div>
    
    <p style="text-align: center; color: #64748b; font-size: 14px; margin-top: 32px;">Need help getting started? Our team is here for you at <a href="mailto:support@hilaq.com" style="color: #5046E5; text-decoration: none;">support@hilaq.com</a></p>
  `,
  });
};

export const auditEventEmail = (data: {
  eventName: string;
  formattedPayload: string;
}): string =>
  wrapInBaseEmail({
    title: `Audit: ${data.eventName}`,
    content: `
    <h1>Audit Event: ${data.eventName}</h1>
    <p>A system audit event occurred at ${new Date().toISOString()}.</p>
    <div style="background-color: #1e293b; color: #f8fafc; padding: 20px; border-radius: 8px; font-family: monospace; font-size: 12px; overflow-x: auto; white-space: pre;">
${data.formattedPayload}
    </div>
  `,
  });

export const formSubmissionConfirmation = (data: {
  submitter_name: string;
  form_title: string;
  amount_paid: string;
  payment_reference: string;
}): string =>
  wrapInBaseEmail({
    title: `Registration Confirmed – ${data.form_title}`,
    previewText: `Your payment for ${data.form_title} has been received.`,
    content: `
    <h1>You're registered! 🎉</h1>
    <p>Hi ${data.submitter_name},</p>
    <p>Your payment has been confirmed and your submission for <strong>${data.form_title}</strong> has been received.</p>

    <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0; border: 1px solid #e2e8f0;">
      <h3 style="margin-top: 0; color: #1e293b; font-size: 16px;">Payment Details</h3>
      <p style="margin: 8px 0; color: #475569;"><strong>Form:</strong> ${data.form_title}</p>
      <p style="margin: 8px 0; color: #475569;"><strong>Amount Paid:</strong> ${data.amount_paid}</p>
      <p style="margin: 8px 0; color: #475569;"><strong>Reference:</strong> ${data.payment_reference}</p>
    </div>

    <p>If you have any questions, please reach out to the organiser or contact <a href="mailto:support@hilaq.com">support@hilaq.com</a>.</p>
  `,
  });

export const formSubmissionOwnerNotification = (data: {
  owner_name: string;
  form_title: string;
  submitter_name: string;
  submitter_email: string;
  amount_received: string;
  payment_reference: string;
  dashboard_url: string;
}): string =>
  wrapInBaseEmail({
    title: `New Form Submission – ${data.form_title}`,
    previewText: `${data.submitter_name} just submitted your form.`,
    content: `
    <h1>New Paid Submission! 🎉</h1>
    <p>Hi ${data.owner_name},</p>
    <p>Great news — <strong>${data.submitter_name}</strong> just submitted your form <strong>${data.form_title}</strong> and payment has been confirmed.</p>

    <div style="background-color: #f8fafc; padding: 24px; border-radius: 12px; margin: 24px 0; border: 1px solid #e2e8f0;">
      <h3 style="margin-top: 0; color: #1e293b; font-size: 16px;">Submission Details</h3>
      <p style="margin: 8px 0; color: #475569;"><strong>Submitter:</strong> ${data.submitter_name}</p>
      <p style="margin: 8px 0; color: #475569;"><strong>Email:</strong> ${data.submitter_email}</p>
      <p style="margin: 8px 0; color: #475569;"><strong>Amount:</strong> ${data.amount_received}</p>
      <p style="margin: 8px 0; color: #475569;"><strong>Reference:</strong> ${data.payment_reference}</p>
    </div>

    ${emailComponents.button("View Submissions", data.dashboard_url)}
    <p>Keep it up — your form is getting traction!</p>
  `,
  });

// ============================================================================
// Scheduling — Booking Emails
// ============================================================================

export const bookingConfirmedAttendee = (data: {
  attendee_name: string;
  event_title: string;
  host_name: string;
  booking_date: string; // "Monday, March 18, 2026"
  start_time: string; // "10:00 AM"
  duration_minutes: number;
  location_label: string;
  meet_link?: string | null;
  timezone: string;
  cancel_url?: string | null;
}): string =>
  wrapInBaseEmail({
    title: `Your booking is confirmed — ${data.event_title}`,
    previewText: `You're booked for ${data.event_title} on ${data.booking_date}`,
    content: `
    <h2 style="margin-bottom: 8px;">You're booked!</h2>
    <p style="margin-top: 0; color: #64748b; font-size: 16px;">Hi ${data.attendee_name}, your booking with <strong>${data.host_name}</strong> is confirmed.</p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; margin: 24px 0;">
      ${emailComponents.infoGroup("Event", data.event_title)}
      ${emailComponents.infoGroup("Date", data.booking_date)}
      ${emailComponents.infoGroup("Time", `${data.start_time} · ${data.duration_minutes < 60 ? `${data.duration_minutes} min` : `${data.duration_minutes / 60} hr`}`)}
      ${emailComponents.infoGroup("Timezone", data.timezone)}
      ${emailComponents.infoGroup("Location", data.location_label)}
    </div>
    ${
      data.meet_link
        ? `
    <p style="font-size: 15px;">A Google Meet link has been generated for this meeting:</p>
    ${emailComponents.button("Join Google Meet", data.meet_link)}
    `
        : ""
    }
    ${
      data.cancel_url
        ? `<p style="font-size: 14px; color: #64748b; margin-top: 24px;">Need to cancel? <a href="${data.cancel_url}" style="color: #6366f1; text-decoration: underline;">Cancel this booking</a></p>`
        : `<p style="font-size: 14px; color: #64748b;">If you need to cancel, please contact ${data.host_name} directly.</p>`
    }
  `,
  });

export const bookingPendingAttendee = (data: {
  attendee_name: string;
  event_title: string;
  host_name: string;
  booking_date: string;
  start_time: string;
  duration_minutes: number;
  timezone: string;
}): string =>
  wrapInBaseEmail({
    title: `Booking request received — ${data.event_title}`,
    previewText: `Your request for ${data.event_title} on ${data.booking_date} is pending confirmation`,
    content: `
    <h2 style="margin-bottom: 8px;">Request received!</h2>
    <p style="margin-top: 0; color: #64748b; font-size: 16px;">Hi ${data.attendee_name}, your booking request with <strong>${data.host_name}</strong> is pending their confirmation.</p>
    <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 10px; padding: 16px 24px; margin: 24px 0;">
      <p style="margin: 0; font-size: 14px; color: #92400e; font-family: 'Inter', sans-serif;">
        <strong>Pending confirmation</strong> — ${data.host_name} will review your request and confirm shortly.
      </p>
    </div>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; margin: 24px 0;">
      ${emailComponents.infoGroup("Event", data.event_title)}
      ${emailComponents.infoGroup("Requested Date", data.booking_date)}
      ${emailComponents.infoGroup("Time", `${data.start_time} · ${data.duration_minutes < 60 ? `${data.duration_minutes} min` : `${data.duration_minutes / 60} hr`}`)}
      ${emailComponents.infoGroup("Timezone", data.timezone)}
    </div>
    <p style="font-size: 14px; color: #64748b;">You'll receive another email once ${data.host_name} confirms your booking.</p>
  `,
  });

export const campaignEmailTemplate = (data: {
  subject: string;
  content: string;
  businessName: string;
  unsubscribeUrl?: string;
}): string => {
  // EmailDragDropBuilder stores a full HTML document (<!DOCTYPE>, <head>, <body>)
  // as campaign content. Sending it directly would double-wrap it inside
  // wrapInBaseEmail's own document, causing duplicated/distorted output.
  // Extract only the inner body content before wrapping.
  let bodyContent = data.content;
  const bodyMatch = data.content.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    bodyContent = bodyMatch[1];
  }
  // Strip the STATE comment embedded for editor state recovery — not for recipients.
  bodyContent = bodyContent.replace(/<!--\s*STATE:[\s\S]*?-->/g, "").trim();

  return wrapInBaseEmail({
    title: data.subject,
    businessName: data.businessName,
    hideLogo: true,
    noPadding: true,
    noFooter: true,
    content: sanitizeEditorHtml(bodyContent),
    footerContent: data.unsubscribeUrl
      ? `<a href="${data.unsubscribeUrl}" style="color: #6366f1; text-decoration: underline; font-size: 13px;">Unsubscribe from these emails</a>`
      : undefined,
  });
};

export const bookingNewHostNotification = (data: {
  host_name: string;
  attendee_name: string;
  attendee_email: string;
  event_title: string;
  booking_date: string;
  start_time: string;
  duration_minutes: number;
  timezone: string;
  attendee_notes?: string | null;
  status: "confirmed" | "pending";
  dashboard_url: string;
}): string =>
  wrapInBaseEmail({
    title: `New booking${data.status === "pending" ? " request" : ""} — ${data.event_title}`,
    previewText: `${data.attendee_name} booked ${data.event_title} for ${data.booking_date}`,
    content: `
    <h2 style="margin-bottom: 8px;">New booking${data.status === "pending" ? " request" : ""}!</h2>
    <p style="margin-top: 0; color: #64748b; font-size: 16px;">
      Hi ${data.host_name}, <strong>${data.attendee_name}</strong> has ${data.status === "pending" ? "requested" : "booked"} a meeting with you.
    </p>
    <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 10px; padding: 24px; margin: 24px 0;">
      ${emailComponents.infoGroup("Event", data.event_title)}
      ${emailComponents.infoGroup("From", `${data.attendee_name} (${data.attendee_email})`)}
      ${emailComponents.infoGroup("Date", data.booking_date)}
      ${emailComponents.infoGroup("Time", `${data.start_time} · ${data.duration_minutes < 60 ? `${data.duration_minutes} min` : `${data.duration_minutes / 60} hr`}`)}
      ${emailComponents.infoGroup("Timezone", data.timezone)}
      ${data.attendee_notes ? emailComponents.infoGroup("Notes", data.attendee_notes) : ""}
    </div>
    ${emailComponents.button("View in Dashboard", data.dashboard_url)}
  `,
  });

export default {
  postNotificationMailToSubscribers,
  eventTicketReceiptCustomer,
  eventTicketVendorNotification,
  newCommentNotification,
  newLikeNotification,
  newSignupNotification,
  newSubscriberNotification,
  tippingConfirmationEmail,
  membershipWelcomeEmail,
  auditEventEmail,
  verificationEmail,
  welcomeEmail,
  formSubmissionConfirmation,
  formSubmissionOwnerNotification,
  bookingConfirmedAttendee,
  bookingPendingAttendee,
  bookingNewHostNotification,
  campaignEmailTemplate,
  teamInvitationEmail: (data: {
    inviterName: string;
    businessName: string;
    inviteeName: string;
    invitationLink: string;
  }): string =>
    wrapInBaseEmail({
      title: `You've been invited to join ${data.businessName} on Hilaq`,
      previewText: `${data.inviterName} has invited you to join their team.`,
      content: `
      <h1>You're invited! 🎉</h1>
      <p>Hi ${data.inviteeName},</p>
      <p><strong>${data.inviterName}</strong> has invited you to join <strong>${data.businessName}</strong> on Hilaq.</p>
      <p>By joining the team, you'll be able to collaborate on projects, manage operations, and grow the business together.</p>
      
      <div style="text-align: center; margin: 32px 0;">
        ${emailComponents.button("Accept Invitation", data.invitationLink)}
      </div>
      
      <p style="font-size: 15px; color: #64748b;">If you don't have an account yet, you'll be prompted to create one before joining.</p>
      <p>We're excited to have you on board!</p>
    `,
    }),
};
