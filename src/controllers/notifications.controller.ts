import { Request, Response } from "express";
import { sendEmail, trackEvent, isConfigured } from "../config/plunk";
import { SupabaseRequest } from "../types/http";
import { supabase } from "../config/supabase";
// utils are JS modules; TS can import them via ES syntax
import {
  chunk,
  truncatePreviewWithEllipsis,
  convertDraftToHtml,
} from "../utils/index";
import {
  postNotificationMailToSubscribers,
  newCommentNotification,
  newLikeNotification,
  newSignupNotification,
  newSubscriberNotification,
} from "../utils/emailsTemplate";

export const handleNewTip = async (req: Request, res: Response) => {
  try {
    const {
      email,
      creator_name,
      tipper_name,
      tip_amount,
      // unsubscribe_url,
    } = req.body;

    const requiredFields = [
      "email",
      "creator_name",
      "tipper_name",
      "tip_amount",
    ];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isConfigured()) {
      return res
        .status(201)
        .json({ success: true, message: "Email skipped (not configured)" });
    }

    await sendEmail({
      name: tipper_name,
      to: email,
      subject: "You’ve Received a Tip on Hilaq!",
      type: "markdown",
      body: `
Dear ${creator_name},

We are excited to let you know that you’ve just received a tip on Hilaq! Your supporters believe in your creative journey, and we’re delighted to help you connect with them.

Tip Details:
  - Amount: ${tip_amount}
  - From: ${tipper_name}
  - Date: ${new Date().toDateString()}

Thank you for creating and sharing your work with the world. Your talent and dedication inspire us all. We hope this tip encourages you to keep doing what you love.

If you have any questions or need further assistance, please do not hesitate to reach out to our support team at support@hilaq.com.

Keep up the fantastic work!

Best regards,  
The Hilaq Team

Note: This is an automated message. Please do not reply directly to this email.`,
    });

    return res.status(201).json({
      success: true,
      message: "Tip notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new comment:", error);
    return res.status(500).json({
      error: "Failed to process tip notification",
      details: error?.message,
    });
  }
};

export const handleNewComment = async (req: Request, res: Response) => {
  console.log("req.body", req.body);
  try {
    const {
      email,
      creator_name,
      commenter_name,
      post_preview,
      comment_text,
      post_url,
      unsubscribe_url,
    } = req.body;

    const requiredFields = [
      "email",
      "creator_name",
      "commenter_name",
      "comment_text",
      "post_url",
    ];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isConfigured()) {
      return res
        .status(201)
        .json({ success: true, message: "Email skipped (not configured)" });
    }

    await sendEmail({
      name: commenter_name,
      to: email,
      subject: "New Comment on Hilaq",
      type: "markdown",
      body: newCommentNotification({
        creator_name,
        commenter_name,
        post_preview: post_preview || "",
        comment_text,
        post_url,
        unsubscribe_url: unsubscribe_url || "",
      }),
    });

    return res.status(201).json({
      success: true,
      message: "Comment notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new comment:", error);
    return res.status(500).json({
      error: "Failed to process comment notification",
      details: error?.message,
    });
  }
};

export const handleNewLike = async (req: Request, res: Response) => {
  console.log("req.body", req.body);
  try {
    const {
      email,
      creator_name,
      liker_name,
      post_preview,
      post_url,
      unsubscribe_url,
    } = req.body;

    const requiredFields = ["email", "creator_name", "liker_name", "post_url"];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isConfigured()) {
      return res
        .status(201)
        .json({ success: true, message: "Email skipped (not configured)" });
    }

    await sendEmail({
      name: liker_name,
      to: email,
      subject: "New Like on Hilaq",
      type: "markdown",
      body: newLikeNotification({
        creator_name,
        liker_name,
        post_preview: post_preview || "",
        post_url,
        unsubscribe_url: unsubscribe_url || "",
      }),
    });

    return res.status(201).json({
      success: true,
      message: "Like notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new like:", error);
    return res.status(500).json({
      error: "Failed to process like notification",
      details: error?.message,
    });
  }
};

export const handleNewPost = async (req: SupabaseRequest, res: Response) => {
  console.log("req.body", req.body);
  try {
    const { email, name, post_id, post_title } = req.body;
    const db = req.supabase;

    const requiredFields = ["email", "name", "post_id", "post_title"];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    // check if email is already sent
    const { data: post, error } = await db
      .from("posts")
      .select("is_email_sent")
      .eq("id", post_id)
      .single();

    if (error) {
      return res.status(500).json({
        error: "Failed to fetch post details",
        details: error.message,
      });
    } else if (post.is_email_sent) {
      return res.status(200).json({
        success: true,
        message: "Post notification already sent",
      });
    }

    if (!isConfigured()) {
      console.warn("Plunk client not configured; skipping event track");
    } else {
      await trackEvent({
        event: "new-post-author",
        email: email,
        data: {
          name,
          post_id,
          post_title,
        },
      });
    }

    const supabaseResponse = await db
      .from("posts")
      .update({
        is_email_sent: true,
      })
      .eq("id", post_id)
      .select();

    console.log("Supabase Response", supabaseResponse);

    return res.status(201).json({
      success: true,
      message: "Post notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new post:", error);
    return res.status(500).json({
      error: "Failed to process post notification",
      details: error?.message,
    });
  }
};

export const handleNewPublication = async (req: Request, res: Response) => {
  console.log("req.body", req.body);
  try {
    const { email, name, pub_id } = req.body;

    const requiredFields = ["email", "name", "pub_id"];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isConfigured()) {
      console.warn("Plunk client not configured; skipping event track");
    } else {
      await trackEvent({
        event: "new-publication-author",
        email: email,
        data: {
          name,
          pub_id,
        },
      });
    }

    return res.status(201).json({
      success: true,
      message: "Publication notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new publication:", error);
    return res.status(500).json({
      error: "Failed to process publication notification",
      details: error?.message,
    });
  }
};

export const handleNewSubscriber = async (req: Request, res: Response) => {
  console.log("req.body", req.body);
  try {
    const {
      email,
      creator_name,
      subscriber_username,
      subscriber_name,
      publication_name,
    } = req.body;

    const requiredFields = [
      "email",
      "creator_name",
      "subscriber_name",
      "publication_name",
    ];
    for (const field of requiredFields) {
      if (!req.body[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    if (!isConfigured()) {
      return res
        .status(201)
        .json({ success: true, message: "Email skipped (not configured)" });
    }

    await sendEmail({
      name: "Hilaq",
      to: email,
      subject: "New Subscriber Alert!",
      type: "markdown",
      body: newSubscriberNotification({
        creator_name,
        subscriber_name,
        publication_name,
        profile_url: "https://www.hilaq.com/profile/" + subscriber_username,
        unsubscribe_url: "https://www.hilaq.com/unsubscribe",
      }),
    });

    return res.status(201).json({
      success: true,
      message: "Subscriber notification sent successfully",
    });
  } catch (error: any) {
    console.error("Error handling new subscriber:", error);
    return res.status(500).json({
      error: "Failed to process subscriber notification",
      details: error?.message,
    });
  }
};

/**
 * Send post notifications to publication subscribers
 * @param {Object} req - Express request object
 * @param {Object} req.body - Request body containing post details
 * @param {string} req.body.pub_id - Publication ID
 * @param {string} req.body.post_id - Post ID
 * @param {string} req.body.post_preview - Post preview content
 * @param {Object} res - Express response object
 * @returns {Promise<Object>} Response object
 */
export const handleNewPostToSubscribers = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const logger = (req as any).logger || console;
  const db = req.supabase;

  try {
    // Validate required fields
    const requiredFields = ["pub_id", "post_id", "post_preview"];
    const missingFields = requiredFields.filter((field) => !req.body[field]);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: "Missing required fields",
        fields: missingFields,
      });
    }

    const { pub_id, post_id, post_preview } = req.body;

    // Idempotency: acquire send lock by flipping is_email_sent false->true.
    const { data: sendGate, error: sendGateError } = await db
      .from("posts")
      .update({ is_email_sent: true })
      .eq("id", post_id)
      .eq("is_email_sent", false)
      .select("id, is_email_sent")
      .maybeSingle();

    if (sendGateError) {
      return res.status(500).json({
        error: "Failed to update post send gate",
        message: sendGateError.message,
      });
    }

    if (!sendGate) {
      return res.status(200).json({
        success: true,
        message: "Post notification already sent",
      });
    }

    try {
      // Fetch post and publication data in parallel
      const [postResponse, subscribersResponse] = await Promise.all([
        getPostDetails(db, post_id),
        getSubscribers(db, pub_id),
      ]);

      // Prepare email data
      const recipients = subscribersResponse.subscribers
        .filter((sub: any) => sub.user?.email)
        .map((sub: any) => ({
          email: sub.user.email,
          name: sub.user.name,
        }));

      const publicationDetails =
        subscribersResponse.subscribers[0]?.publication;

      const emails = recipients.map((recipient: any) => ({
        to: recipient.email,
        name:
          publicationDetails.name ||
          postResponse.post.author.name ||
          "Hilaq Publication",
        subject: postResponse.post.title,
        type: "html",
        body: postNotificationMailToSubscribers({
          author_name: postResponse.post.author.name,
          name: recipient.name,
          post_id,
          post_title: postResponse.post.title,
          post_subtitle: postResponse.post.subtitle || "",
          post_content: convertDraftToHtml(postResponse.post.body || ""),
          pub_name: publicationDetails.name,
          cover_image: postResponse.post.cover_image || null,
        }),
      }));

      // Send emails in batches
      await sendEmailsToBatchPlunk({ emails });

      return res.status(201).json({
        success: true,
        message: "Post notification sent successfully",
        recipientCount: recipients.length,
      });
    } catch (sendError: any) {
      // Rollback: flip is_email_sent back to false so the retry job can pick it up
      logger.error(
        `Email send failed for post ${post_id}, rolling back is_email_sent:`,
        sendError?.message,
      );
      await db.from("posts").update({ is_email_sent: false }).eq("id", post_id);

      return res.status(500).json({
        error: "Failed to send post notification (will retry)",
        message: sendError?.message,
      });
    }
  } catch (error: any) {
    console.error("Error handling new post to subscribers:", {
      error: error?.message,
      stack: error?.stack,
      requestBody: req.body,
    });

    return res.status(error?.statusCode || 500).json({
      error: "Failed to process post notification",
      message: error?.message,
    });
  }
};

/**
 * Fetch post details from database
 * @param {SupabaseClient} db - Supabase client
 * @param {string} postId - Post ID
 * @returns {Promise<Object>} Post details
 */
async function getPostDetails(db: any, postId: string) {
  const { data: post, error } = await db
    .from("posts")
    .select("*, author:user_id(name)")
    .eq("id", postId)
    .single();

  if (error) {
    throw new CustomError("Failed to fetch post details", 404, error as any);
  }

  return { post };
}

/**
 * Fetch subscribers from database
 * @param {SupabaseClient} db - Supabase client
 * @param {string} pubId - Publication ID
 * @returns {Promise<Object>} Subscribers details
 */
async function getSubscribers(db: any, pubId: string) {
  const { data: subscribers, error } = await db
    .from("subscriptions")
    .select(
      `
      *,
      user:user_id(email, name),
      publication:publication_id(name, description)
    `,
    )
    .eq("publication_id", pubId);

  if (error) {
    throw new CustomError("Failed to fetch subscribers", 404, error as any);
  }

  return { subscribers };
}

// [TO_FIX] might be an issue when sending to a lot of batches
// It will block node execution
/**
 * Send emails in batches
 * @param {Object} emails - Prepared email data
 * @returns {Promise<void>}
 */
async function sendEmailsToBatchPlunk({ emails }: { emails: any[] }) {
  const BATCH_SIZE = 50;
  const batches = chunk(emails, BATCH_SIZE);

  for (const batch of batches) {
    if (!isConfigured()) {
      console.warn("Plunk client not configured; skipping batch email send");
      continue;
    }
    const messageResponses = await Promise.all(
      batch.map((email: any) => sendEmail(email)),
    );
    console.log("Message Responses", messageResponses);
  }
}

/**
 * Custom error class for better error handling
 */
class CustomError extends Error {
  public statusCode: number;
  public originalError: any;
  constructor(message: string, statusCode = 500, originalError: any = null) {
    super(message);
    this.statusCode = statusCode;
    this.originalError = originalError;
  }
}
