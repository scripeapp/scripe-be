import { sendEmail, isConfigured } from "../config/plunk";

type FormatType = "markdown" | "html";
interface CreateNotificationInput {
  toEmail: string;
  emailName: string;
  emailSubject: string;
  formatType?: FormatType;
  emailBody: string;
  replyTo?: string;
  fromEmail?: string;
  metadata?: Record<string, string | number | boolean>;
}

class NotificationService {
  async createNotification({
    toEmail,
    emailName,
    emailSubject,
    formatType = "html",
    emailBody,
    replyTo,
    fromEmail,
    metadata,
  }: CreateNotificationInput): Promise<{ emailId: string | null }> {
    // Avoid logging full email bodies in production send paths (large campaign sends).
    if (process.env.NODE_ENV !== "production") {
      console.log("[NotificationService.createNotification]", {
        toEmail,
        emailName,
        emailSubject,
        formatType,
        hasBody: !!emailBody,
        replyTo,
        fromEmail,
      });
    }

    if (!isConfigured()) {
      throw new Error("Plunk client not configured (missing PLUNK_API_KEY)");
    }

    const resp = await sendEmail({
      to: toEmail,
      name: emailName,
      subject: emailSubject,
      type: formatType,
      body: emailBody,
      ...(replyTo ? { replyTo } : {}),
      ...(fromEmail ? { from: fromEmail } : {}),
      ...(metadata ? { metadata } : {}),
    });

    // Extract the email record id — this is what the tracking webhook echoes
    // back as event.emailId, so it's our correlation key.
    //
    // Plunk's /send response is:
    //   { success, emails: [{ contact: { id, email }, email: "<EMAIL-UUID>" }] }
    // where `emails[].email` is the email record UUID (NOT the address — the
    // address is `emails[].contact.email`). Newer API builds may also return a
    // top-level `emailId`, so prefer that when present.
    const emailId: string | null =
      resp?.emailId ?? resp?.emails?.[0]?.email ?? null;

    return { emailId };
  }

  async sendNewCommentNotification(
    post: any,
    comment: any,
    commenter: any,
  ): Promise<void> {
    try {
      const { NotificationUtil } = await import("../utils/notification.util");
      const { newCommentNotification } =
        await import("../utils/emailsTemplate");

      // Check author preferences
      const shouldSend = await NotificationUtil.shouldSendNotification(
        post.user_id,
        "email_new_comment",
      );

      if (!shouldSend) {
        console.log(
          `Skipping new comment notification for user ${post.user_id} based on preferences`,
        );
        return;
      }

      const emailBody = newCommentNotification({
        creator_name: post.user_id.name || "Creator",
        commenter_name: commenter.name || "User",
        post_preview: post.title || "your post",
        comment_text: comment.comment_text,
        post_url: `https://www.hilaq.com/posts/${post.id}`,
        unsubscribe_url: "https://www.hilaq.com/settings/notifications",
      });

      await this.createNotification({
        toEmail: post.user_id.email,
        emailName: "Hilaq",
        emailSubject: "New comment on your post",
        emailBody,
      });

      console.log(`New comment notification sent to ${post.user_id.email}`);
    } catch (error) {
      console.error("Failed to send new comment notification:", error);
    }
  }

  async sendNewLikeNotification(
    post: any,
    liker: any,
  ): Promise<void> {
    try {
      const { NotificationUtil } = await import("../utils/notification.util");
      const { newLikeNotification } =
        await import("../utils/emailsTemplate");

      // Check author preferences
      const shouldSend = await NotificationUtil.shouldSendNotification(
        post.user_id,
        "email_new_like",
      );

      if (!shouldSend) {
        console.log(
          `Skipping new like notification for user ${post.user_id} based on preferences`,
        );
        return;
      }

      const emailBody = newLikeNotification({
        creator_name: post.user_id.name || "Creator",
        liker_name: liker.name || "User",
        post_preview: post.title || "your post",
        post_url: `https://www.hilaq.com/posts/${post.id}`,
        unsubscribe_url: "https://www.hilaq.com/settings/notifications",
      });

      await this.createNotification({
        toEmail: post.user_id.email,
        emailName: "Hilaq",
        emailSubject: "New like on your post",
        emailBody,
      });

      console.log(`New like notification sent to ${post.user_id.email}`);
    } catch (error) {
      console.error("Failed to send new like notification:", error);
    }
  }
}

export const notificationService = new NotificationService();
