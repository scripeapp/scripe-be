import { Request, Response } from "express";
import { Receiver } from "@upstash/qstash";
import { supabaseAdmin } from "../config/supabaseAdmin";
import { notificationService } from "../services/notification.services";
import { campaignEmailTemplate } from "../utils/emailsTemplate";
import ApiResponse from "../utils/apiResponse";
import {
  isQStashAvailable,
  queueCampaignJob,
  CampaignJobPayload,
} from "../config/qstash";

if (!supabaseAdmin) {
  throw new Error("Supabase Admin not initialized");
}

interface CrmContact {
  id: string;
  email: string | null;
  name: string | null;
  status: string;
}

interface CampaignAudience {
  audience_type: "all_contacts" | "segment" | "manual";
  audience_ref?: string | null;
}

interface CampaignRecord {
  id: string;
  subject: string;
  content: string | { html: string; text: string } | null;
  audience_type: "all_contacts" | "segment" | "manual";
  audience_ref?: string | null;
  author?: { email: string } | null;
}

export class CampaignProcessController {
  // 10 emails per batch — each batch completes in ~1-3s, well under Vercel's timeout.
  // Smaller = more reliable. QStash queues the next batch automatically.
  private static readonly BATCH_SIZE = 10;

  private readonly db = supabaseAdmin!;

  private readonly receiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || "",
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || "",
  });

  private async sendCampaignEmail(params: {
    campaignId: string;
    businessId: string;
    contact: CrmContact;
    senderName: string;
    senderEmail: string;
    subject: string;
    replyTo?: string;
    parsedContent: { html: string; text: string };
  }): Promise<{ success: boolean; plunkEmailId: string | null }> {
    try {
      const nameParts = params.contact.name?.trim().split(" ") ?? [];
      const firstName = nameParts[0] ?? "";
      const lastName = nameParts.slice(1).join(" ");
      const email = params.contact.email ?? "";

      let personalizedHtml = params.parsedContent.html || "";
      let personalizedText = params.parsedContent.text || "";

      if (personalizedHtml) {
        personalizedHtml = personalizedHtml
          .replace(/{{first_name}}/gi, firstName)
          .replace(/{{last_name}}/gi, lastName)
          .replace(/{{email}}/gi, email)
          .replace(/{{company}}/gi, "");
      }

      if (personalizedText) {
        personalizedText = personalizedText
          .replace(/{{first_name}}/gi, firstName)
          .replace(/{{last_name}}/gi, lastName)
          .replace(/{{email}}/gi, email)
          .replace(/{{company}}/gi, "");
      }

      const brandedHtml = campaignEmailTemplate({
        subject: params.subject,
        content: personalizedHtml || personalizedText || "",
        businessName: params.senderName,
        unsubscribeUrl: `https://www.hilaq.com/unsubscribe?email=${encodeURIComponent(params.contact.email ?? "")}&campaign=${params.campaignId}`,
      });

      const { emailId } = await notificationService.createNotification({
        toEmail: params.contact.email ?? "",
        emailName: params.senderName,
        emailSubject: params.subject,
        formatType: "html",
        emailBody: brandedHtml,
        replyTo: params.replyTo,
        fromEmail: params.senderEmail,
        metadata: {
          campaign_id: params.campaignId,
          contact_email: params.contact.email ?? "",
          business_id: params.businessId,
        },
      });

      console.log(
        `[CampaignProcess] Sent to ${params.contact.email} via ${params.senderEmail}`,
      );
      return { success: true, plunkEmailId: emailId };
    } catch (error) {
      console.error(
        `[CampaignProcess] Failed to send to ${params.contact.email}:`,
        error,
      );
      return { success: false, plunkEmailId: null };
    }
  }

  private async getCampaignContacts(
    businessId: string,
    audience: CampaignAudience,
    startCursorId: string | null,
    limit: number,
  ): Promise<{
    contacts: CrmContact[];
    nextCursorId: string | null;
    hasMore: boolean;
  }> {
    if (audience.audience_type === "all_contacts") {
      let query = this.db
        .from("crm_contacts_unified")
        .select("id, email, name, status")
        .eq("business_id", businessId)
        .eq("status", "marketing")
        .order("id")
        .limit(limit + 1);

      if (startCursorId) {
        query = query.gt("id", startCursorId);
      }

      const { data, error } = await query;

      if (error) throw new Error(`Failed to fetch contacts: ${error.message}`);

      const hasMore = (data?.length || 0) > limit;
      const contacts = hasMore ? data!.slice(0, limit) : data || [];
      const nextCursorId =
        contacts.length > 0 ? contacts[contacts.length - 1].id : null;

      return { contacts: contacts as CrmContact[], nextCursorId, hasMore };
    }

    if (audience.audience_type === "segment") {
      const segmentId = audience.audience_ref;
      if (!segmentId)
        return { contacts: [], nextCursorId: null, hasMore: false };

      const offset = startCursorId ? parseInt(startCursorId, 10) : 0;

      // Fetch limit+1 (range is inclusive) to detect if there are more pages
      const { data: contactSegments, error: segError } = await this.db
        .from("contact_segments")
        .select("contact_id")
        .eq("segment_id", segmentId)
        .range(offset, offset + limit);

      if (segError)
        throw new Error(`Failed to fetch segment: ${segError.message}`);
      if (!contactSegments || contactSegments.length === 0) {
        return { contacts: [], nextCursorId: null, hasMore: false };
      }

      const hasMore = contactSegments.length > limit;
      const slicedSegments = hasMore
        ? contactSegments.slice(0, limit)
        : contactSegments;
      const nextCursorId = hasMore ? String(offset + limit) : null;

      const ids = slicedSegments.map(
        (cs: { contact_id: string }) => cs.contact_id,
      );
      const { data: contacts, error: contactsError } = await this.db
        .from("crm_contacts_unified")
        .select("id, email, name, status")
        .eq("business_id", businessId)
        .in("id", ids)
        .eq("status", "marketing");

      if (contactsError)
        throw new Error(`Failed to fetch contacts: ${contactsError.message}`);

      return {
        contacts: (contacts as CrmContact[]) || [],
        nextCursorId,
        hasMore,
      };
    }

    console.warn(
      `[CampaignProcess] Unhandled audience type: ${audience.audience_type}`,
    );
    return { contacts: [], nextCursorId: null, hasMore: false };
  }

  private async processCampaignBatch(payload: CampaignJobPayload): Promise<{
    sent: number;
    failed: number;
    hasMore: boolean;
    nextCursorId: string | null;
  }> {
    const { campaignId, businessId, cursorId } = payload;

    console.log(
      `[CampaignProcess] Processing batch for campaign ${campaignId}, cursor: ${cursorId || "start"}`,
    );

    const { data: campaign, error: campaignError } = await this.db
      .from("campaigns")
      .select("*, author:user_id(email)")
      .eq("id", campaignId)
      .single();

    if (campaignError || !campaign) {
      throw new Error(`Campaign not found: ${campaignId}`);
    }

    const typedCampaign = campaign as unknown as CampaignRecord;

    const { data: business } = await this.db
      .from("businesses")
      .select("name, slug")
      .eq("id", businessId)
      .single();

    const businessSlug =
      business?.slug ||
      business?.name
        ?.toLowerCase()
        .replace(/[^a-z0-9]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 30) ||
      "business";
    const senderName = business?.name || "Hilaq";
    const senderEmail = `${businessSlug}@hilaq.com`;

    let parsedContent = { html: "", text: "" };
    if (typedCampaign.content) {
      if (typeof typedCampaign.content === "string") {
        try {
          parsedContent = JSON.parse(typedCampaign.content);
        } catch {
          parsedContent = {
            html: typedCampaign.content,
            text: typedCampaign.content,
          };
        }
      } else {
        parsedContent = {
          html: typedCampaign.content.html || "",
          text: typedCampaign.content.text || "",
        };
      }
    }

    // Fan-out Layer.
    const { contacts, nextCursorId, hasMore } =
      await this.getCampaignContacts(
        businessId,
        {
          audience_type: typedCampaign.audience_type,
          audience_ref: typedCampaign.audience_ref,
        },
        cursorId || null,
        CampaignProcessController.BATCH_SIZE,
      );

    // Pre-fetch existing logs for the batch to avoid N+1 queries
    const contactEmails = contacts
      .map((c) => c.email?.trim().toLowerCase())
      .filter((e): e is string => Boolean(e));

    let sentEmails = new Set<string>();
    if (contactEmails.length > 0) {
      const { data: existingLogs } = await this.db
        .from("campaign_email_logs")
        .select("contact_email")
        .eq("campaign_id", campaignId)
        .in("contact_email", contactEmails);

      sentEmails = new Set(
        existingLogs?.map(
          (l: { contact_email: string }) => l.contact_email,
        ) ?? [],
      );
    }

    // Filter out already-sent and invalid emails before launching parallel sends
    const pending = contacts.filter((c) => {
      const email = (c.email || "").trim().toLowerCase();
      return email && !sentEmails.has(email);
    });

    // Send all emails in this batch in parallel — 10 concurrent calls finish in ~1-3s
    const results = await Promise.allSettled(
      pending.map((contact) =>
        this.sendCampaignEmail({
          campaignId,
          businessId,
          contact,
          senderName,
          senderEmail,
          subject: typedCampaign.subject,
          replyTo: typedCampaign.author?.email,
          parsedContent,
        }).then((res) => ({ contact, ...res })),
      ),
    );

    let sentCount = 0;
    let failedCount = 0;
    const now = new Date().toISOString();
    // Track the Plunk emailId per recipient so tracking webhooks can correlate
    // back to the exact send (see plunk-webhook.controller).
    const successful: { email: string; plunkEmailId: string | null }[] = [];

    for (const result of results) {
      if (result.status === "rejected") {
        failedCount++;
        continue;
      }
      const { contact, success, plunkEmailId } = result.value;
      if (success) {
        sentCount++;
        successful.push({
          email: (contact.email || "").trim().toLowerCase(),
          plunkEmailId,
        });
      } else {
        failedCount++;
      }
    }

    // Await log writes before returning — this is what makes QStash retries safe.
    // If we returned first and QStash retried the batch, the pre-fetch dedup would
    // miss unwritten logs and send duplicates.
    if (successful.length > 0) {
      await Promise.allSettled(
        successful.map(({ email: contactEmail, plunkEmailId }) =>
          this.db.from("campaign_email_logs").upsert(
            {
              campaign_id: campaignId,
              contact_email: contactEmail,
              business_id: businessId,
              status: "sent",
              sent_at: now,
              plunk_email_id: plunkEmailId,
            },
            { onConflict: "campaign_id,contact_email" },
          ),
        ),
      );

      // Metric increment is a counter — fire-and-forget is acceptable here
      void Promise.resolve(
        this.db.rpc("increment_campaign_metric", {
          target_campaign_id: campaignId,
          metric_key: "sent",
          increment_amount: sentCount,
        }),
      ).catch((err: unknown) =>
        console.error("[CampaignProcess] Metric increment failed:", err),
      );
    }

    console.log(
      `[CampaignProcess] Batch done — sent=${sentCount}, failed=${failedCount}, skipped=${contacts.length - pending.length}, hasMore=${hasMore}`,
    );

    return { sent: sentCount, failed: failedCount, hasMore, nextCursorId };
  }

  private async getTotalSentCount(campaignId: string): Promise<number> {
    const { count } = await this.db
      .from("campaign_email_logs")
      .select("*", { count: "exact", head: true })
      .eq("campaign_id", campaignId);
    return count || 0;
  }

  private async finalizeCampaign(
    campaignId: string,
    dbJobId: string | null,
    finalStatus: "sent" | "failed",
  ): Promise<void> {
    const now = new Date().toISOString();

    await this.db
      .from("campaigns")
      .update({
        status: finalStatus,
        sent_at: finalStatus === "sent" ? now : null,
        updated_at: now,
      })
      .eq("id", campaignId);

    if (dbJobId) {
      await this.db
        .from("campaign_send_jobs")
        .update({
          status: "completed",
          completed_at: now,
          updated_at: now,
        })
        .eq("id", dbJobId);
    }

    console.log(
      `[CampaignProcess] Campaign ${campaignId} finalized: ${finalStatus}`,
    );
  }

  private async queueNextBatch(
    payload: CampaignJobPayload,
    cursorId: string,
  ): Promise<void> {
    if (!isQStashAvailable()) {
      console.error(
        `[CampaignProcess] QStash unavailable — campaign ${payload.campaignId} stalled at cursor ${cursorId}`,
      );
      return;
    }

    await queueCampaignJob({
      campaignId: payload.campaignId,
      businessId: payload.businessId,
      dbJobId: payload.dbJobId,
      isRetry: payload.isRetry,
      cursorId,
    });
    console.log(`[CampaignProcess] Queued next batch with cursor: ${cursorId}`);
  }

  async process(req: Request, res: Response): Promise<Response> {
    if (process.env.NODE_ENV === "production") {
      const signature = req.headers["upstash-signature"] as string | undefined;

      if (!signature) {
        console.error("[CampaignProcess] Missing signature");
        return res.status(401).json({ error: "Unauthorized" });
      }

      try {
        const isValid = await this.receiver.verify({
          signature,
          body: JSON.stringify(req.body),
        });

        if (!isValid) {
          console.error("[CampaignProcess] Invalid signature");
          return res.status(401).json({ error: "Unauthorized" });
        }
      } catch (err) {
        console.error("[CampaignProcess] Signature verification error:", err);
        return res.status(401).json({ error: "Unauthorized" });
      }
    }

    try {
      const payload = req.body as CampaignJobPayload;
      const { sent, failed, hasMore, nextCursorId } =
        await this.processCampaignBatch(payload);

      if (hasMore && nextCursorId) {
        await this.queueNextBatch(payload, nextCursorId);
      } else if (!hasMore) {
        // Only mark failed if nothing was sent at all — partial sends count as "sent"
        const totalSent = await this.getTotalSentCount(payload.campaignId);
        await this.finalizeCampaign(
          payload.campaignId,
          payload.dbJobId,
          totalSent > 0 ? "sent" : "failed",
        );
      }

      return ApiResponse.success(res, "Batch processed", {
        sent,
        failed,
        hasMore,
        nextCursorId,
      });
    } catch (error) {
      console.error("[CampaignProcess] Error:", error);
      return ApiResponse.serverError(res, (error as Error).message);
    }
  }

  async failure(req: Request, res: Response): Promise<Response> {
    try {
      const body = req.body as CampaignJobPayload & { error?: string };

      console.log(
        `[CampaignFailure] Job failed for campaign ${body.campaignId}:`,
        body.error,
      );

      if (body.dbJobId) {
        await this.db
          .from("campaign_send_jobs")
          .update({
            status: "failed",
            error_message: body.error || "Job failed after all retries",
            updated_at: new Date().toISOString(),
          })
          .eq("id", body.dbJobId);
      }

      await this.db
        .from("campaigns")
        .update({
          status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", body.campaignId);

      return ApiResponse.success(res, "Failure recorded", { success: true });
    } catch (error) {
      console.error("[CampaignFailure] Error:", error);
      return ApiResponse.serverError(res, (error as Error).message);
    }
  }
}

export default new CampaignProcessController();
