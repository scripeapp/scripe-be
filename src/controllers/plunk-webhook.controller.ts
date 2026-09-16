import { Request, Response } from "express";
import { supabaseAdmin } from "../config/supabaseAdmin";

// Plunk's webhook payload has no top-level event-type field. The type is
// inferred from which fields are present in the `event` object.
interface PlunkWebhookBody {
  contact?: { email?: string; subscribed?: boolean; data?: any };
  workflow?: { id?: string; name?: string };
  execution?: { id?: string; startedAt?: string };
  event?: {
    emailId?: string; // Plunk's id for the sent email — our correlation key
    campaignId?: string | null;
    sourceType?: string; // "CAMPAIGN" | "TRANSACTIONAL" | ...
    deliveredAt?: string;
    openedAt?: string;
    opens?: number;
    clickedAt?: string;
    clicks?: number;
    bouncedAt?: string;
    bounceType?: string;
    unsubscribedAt?: string;
    [key: string]: any;
  };
}

// Infer the event type from the `event` object's fields. Order matters:
// check the most specific / terminal events first.
function detectEventType(ev?: PlunkWebhookBody["event"]): string | null {
  if (!ev) return null;
  if (ev.bouncedAt || ev.bounceType) return "email.bounced";
  if (ev.unsubscribedAt) return "email.unsubscribed";
  if (ev.clickedAt || typeof ev.clicks === "number") return "email.clicked";
  if (ev.openedAt || typeof ev.opens === "number") return "email.opened";
  if (ev.deliveredAt) return "email.delivered";
  return null;
}

// Maps Plunk event type → { status, timestampColumn, metricKey }
const EVENT_MAP: Record<
  string,
  { status: string; timestampCol: string; metricKey: string | null }
> = {
  "email.delivered": {
    status: "delivered",
    timestampCol: "delivered_at",
    metricKey: "delivered",
  },
  "email.opened": {
    status: "opened",
    timestampCol: "opened_at",
    metricKey: "opens",
  },
  "email.clicked": {
    status: "clicked",
    timestampCol: "clicked_at",
    metricKey: "clicks",
  },
  "email.bounced": {
    status: "bounced",
    timestampCol: "bounced_at",
    metricKey: "bounces",
  },
  "email.unsubscribed": {
    status: "unsubscribed",
    timestampCol: "unsubscribed_at",
    metricKey: null,
  },
};

class PlunkWebhookController {
  async handleWebhook(req: Request, res: Response): Promise<Response> {
    if (!supabaseAdmin) {
      return res.status(500).json({ error: "Database not available" });
    }

    try {
      // TEMP (non-prod only): log the raw payload to confirm the remaining
      // event shapes (e.g. unsubscribe). Gated to avoid logging PII in prod.
      if (process.env.NODE_ENV !== "production") {
        console.log("[PlunkWebhook] raw payload:", JSON.stringify(req.body));
      }

      const body = req.body as PlunkWebhookBody;
      const ev = body.event ?? {};
      const type = detectEventType(ev);
      const contactEmail = body.contact?.email?.toLowerCase();
      const eventTime =
        ev.bouncedAt ||
        ev.unsubscribedAt ||
        ev.clickedAt ||
        ev.openedAt ||
        ev.deliveredAt ||
        new Date().toISOString();

      console.log(
        `[PlunkWebhook] ${type ?? "unknown"} for ${contactEmail} (source=${ev.sourceType})`,
      );

      const mapping = type ? EVENT_MAP[type] : null;
      if (!mapping) {
        return res.status(200).json({ received: true });
      }

      if (!contactEmail) {
        console.warn("[PlunkWebhook] Missing contact email in event");
        return res.status(200).json({ received: true });
      }

      // Resolve the campaign.
      let campaignId: string | undefined;
      let businessId: string | undefined;

      // PRIMARY: correlate by Plunk's emailId, stored on the log row at send
      // time. This is exact and immune to mis-attribution. Hilaq sends CRM
      // campaign emails via Plunk's transactional API, so the webhook arrives
      // with sourceType="TRANSACTIONAL" / campaignId=null — emailId is the only
      // reliable key Plunk echoes back.
      if (ev.emailId) {
        const { data: logRow } = await supabaseAdmin
          .from("campaign_email_logs")
          .select("campaign_id, business_id")
          .eq("plunk_email_id", ev.emailId)
          .maybeSingle();
        if (logRow) {
          campaignId = logRow.campaign_id;
          businessId = logRow.business_id;
        }
      }

      // FALLBACK (legacy sends with no stored emailId): match by recipient email
      // against a campaign log whose timestamp for THIS event type is still
      // unset (most recent first). Can occasionally mis-attribute.
      if (!campaignId) {
        const { data: logRow } = await supabaseAdmin
          .from("campaign_email_logs")
          .select("campaign_id, business_id")
          .eq("contact_email", contactEmail)
          .is(mapping.timestampCol, null)
          .order("sent_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (!logRow) {
          console.warn(
            `[PlunkWebhook] No campaign log found for ${contactEmail} (emailId=${ev.emailId ?? "none"})`,
          );
          return res.status(200).json({ received: true });
        }
        campaignId = logRow.campaign_id;
        businessId = logRow.business_id;
      }

      // 1. Update individual log row with real status + timestamp.
      // Select back business_id so we have it for unsubscribe logging when the
      // campaignId came straight from the Plunk payload.
      const { data: updatedRows, error: logError } = await supabaseAdmin
        .from("campaign_email_logs")
        .update({
          status: mapping.status,
          [mapping.timestampCol]: eventTime,
        })
        .eq("campaign_id", campaignId)
        .eq("contact_email", contactEmail)
        .select("business_id");

      if (logError) {
        console.error(
          "[PlunkWebhook] Failed to update campaign_email_logs:",
          logError,
        );
      }
      if (!businessId && updatedRows?.[0]?.business_id) {
        businessId = updatedRows[0].business_id;
      }

      // 2. Increment aggregate campaign metric atomically.
      // Plunk fires a webhook on EVERY open/click, so only count the first one
      // to avoid inflating open/click rates beyond unique recipients.
      const isRepeatEngagement =
        (type === "email.opened" && ev.isFirstOpen === false) ||
        (type === "email.clicked" && ev.isFirstClick === false);

      if (mapping.metricKey && !isRepeatEngagement) {
        const { error: rpcError } = await supabaseAdmin.rpc(
          "increment_campaign_metric",
          {
            target_campaign_id: campaignId,
            metric_key: mapping.metricKey,
            increment_amount: 1,
          },
        );
        if (rpcError) {
          console.error(
            `[PlunkWebhook] Failed to increment metric ${mapping.metricKey}:`,
            rpcError,
          );
        }
      }

      // 3. Log unsubscribes to segment_activity for CRM segmentation
      if (type === "email.unsubscribed" && businessId) {
        await supabaseAdmin.from("segment_activity").insert({
          business_id: businessId,
          email: contactEmail,
          activity_type: "email_unsubscribed",
          metadata: {
            campaign_id: campaignId,
            timestamp: eventTime,
          },
        });
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error("[PlunkWebhook] Internal error:", err);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }
}

export default new PlunkWebhookController();
