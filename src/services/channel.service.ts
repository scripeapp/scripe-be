// ============================================================================
// ChannelService — Business logic for WhatsApp & SMS marketing
// Uses business_id (same pattern as crm.service.ts)
// ============================================================================

import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { queueChannelCampaignJob } from "../config/qstash";
import {
  appendSmsOptOutFooter,
  calculateChannelCost,
} from "./channel-message-cost.service";
import { normalizeInternationalPhone } from "../utils/phone-number";
import type {
  ChannelType,
  ChannelMessage,
  ChannelTemplate,
  ChannelMessageStat,
  CreateMessageBody,
  CreateTemplateBody,
} from "../types/channel.types";

interface ChannelRecipient {
  id: string;
  name: string | null;
  email: string | null;
  phone: string;
  metadata: Record<string, unknown> | null;
}

interface PreparedDelivery {
  message_id: string;
  business_id: string;
  contact_id: string;
  phone: string;
  body: string;
  credit_cost: number;
  status: "pending";
}

interface ChannelMessageQueryRecord extends Omit<ChannelMessage, "stats"> {
}

interface AggregateMessageRecord {
  recipient_count: number | null;
  accepted_count: number;
  delivered_count: number;
  read_count: number;
  replied_count: number;
  clicked_count: number;
  optout_count: number;
}

const RECIPIENT_PAGE_SIZE = 500;
const DELIVERY_INSERT_SIZE = 250;
const CHANNEL_MESSAGE_COLUMNS =
  "id, business_id, channel, name, status, segment_id, template_id, body_override, scheduled_at, sent_at, recipient_count, suppressed_count, accepted_count, delivered_count, read_count, replied_count, clicked_count, optout_count, failed_count, credits_reserved, credits_refunded, message_parts, provider, queue_message_id, send_attempt_id, created_by, created_at, updated_at";
const CHANNEL_TEMPLATE_COLUMNS =
  "id, business_id, channel, name, category, header_type, header_content, body, footer, buttons, wa_template_id, status, rejection_reason, created_by, created_at, updated_at";

export class ChannelService {
  constructor(private readonly supabase: SupabaseClient) {}

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private interpolate(body: string, contact: ChannelRecipient): string {
    const nameParts = contact.name?.trim().split(/\s+/) ?? [];
    const firstName = nameParts[0] ?? "";
    const city =
      typeof contact.metadata?.city === "string" ? contact.metadata.city : "";
    const loyaltyPoints =
      typeof contact.metadata?.loyalty_points === "number"
        ? contact.metadata.loyalty_points
        : 0;

    return body
      .replace(/\{\{first_name\}\}/gi, firstName)
      .replace(/\{\{name\}\}/gi, contact.name ?? "")
      .replace(/\{\{email\}\}/gi, contact.email ?? "")
      .replace(/\{\{city\}\}/gi, city)
      .replace(/\{\{loyalty_points\}\}/gi, String(loyaltyPoints))
      .replace(/\{\{1\}\}/gi, firstName)
      .replace(/\{\{2\}\}/gi, contact.email ?? "");
  }

  /**
   * Resolve a segment to opted-in contacts with phone numbers.
   * Handles: opt-in/opt-out filtering, deduplication by phone.
   */
  private async resolveRecipients(
    channel: ChannelType,
    segmentId: string | null,
    businessId: string,
  ): Promise<{ contacts: ChannelRecipient[]; suppressed: number }> {
    const segmentContactIds = segmentId
      ? await this.getSegmentContactIds(segmentId, businessId)
      : null;
    if (segmentContactIds?.length === 0) return { contacts: [], suppressed: 0 };

    const contacts = await this.getEligibleContacts(
      channel,
      businessId,
      segmentContactIds,
    );
    const uniqueContacts = new Map<string, ChannelRecipient>();
    let suppressed = 0;

    for (const contact of contacts) {
      const phone = normalizeInternationalPhone(contact.phone || "");
      if (!phone || uniqueContacts.has(phone)) {
        suppressed += 1;
        continue;
      }

      uniqueContacts.set(phone, { ...contact, phone });
    }

    return { contacts: [...uniqueContacts.values()], suppressed };
  }

  private async getSegmentContactIds(
    segmentId: string,
    businessId: string,
  ): Promise<string[]> {
    const { data: segment, error: segmentError } = await this.supabase
      .from("segments")
      .select("id")
      .eq("id", segmentId)
      .eq("business_id", businessId)
      .maybeSingle();
    if (segmentError) throw segmentError;
    if (!segment) {
      throw Object.assign(new Error("Segment not found for this business."), {
        statusCode: 404,
      });
    }

    const contactIds: string[] = [];

    for (let from = 0; ; from += RECIPIENT_PAGE_SIZE) {
      const { data, error } = await this.supabase
        .from("contact_segments")
        .select("contact_id")
        .eq("segment_id", segmentId)
        .range(from, from + RECIPIENT_PAGE_SIZE - 1);
      if (error) throw error;

      const page = (data ?? []) as Array<{ contact_id: string }>;
      contactIds.push(...page.map((item) => item.contact_id));
      if (page.length < RECIPIENT_PAGE_SIZE) return contactIds;
    }
  }

  private async getEligibleContacts(
    channel: ChannelType,
    businessId: string,
    contactIds: string[] | null,
  ): Promise<ChannelRecipient[]> {
    const contacts: ChannelRecipient[] = [];
    const idGroups = contactIds
      ? Array.from(
          { length: Math.ceil(contactIds.length / RECIPIENT_PAGE_SIZE) },
          (_, index) =>
            contactIds.slice(
              index * RECIPIENT_PAGE_SIZE,
              (index + 1) * RECIPIENT_PAGE_SIZE,
            ),
        )
      : [null];

    for (const idGroup of idGroups) {
      for (let from = 0; ; from += RECIPIENT_PAGE_SIZE) {
        let query = this.supabase
          .from("contacts")
          .select("id, name, email, phone, metadata")
          .eq("business_id", businessId)
          .not("phone", "is", null)
          .order("id")
          .range(from, from + RECIPIENT_PAGE_SIZE - 1);

        query =
          channel === "whatsapp"
            ? query.eq("whatsapp_opted_in", true)
            : query.eq("sms_opted_out", false);
        if (idGroup) query = query.in("id", idGroup);

        const { data, error } = await query;
        if (error) throw error;
        const page = (data ?? []) as ChannelRecipient[];
        contacts.push(...page);
        if (page.length < RECIPIENT_PAGE_SIZE) break;
      }
    }

    return contacts;
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  async getMessages(
    businessId: string,
    channel: ChannelType,
    opts: {
      status?: string;
      search?: string;
      page?: number;
      per_page?: number;
    },
  ) {
    const { status, search } = opts;
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const per_page = Math.min(100, Math.max(1, Math.floor(opts.per_page ?? 20)));
    const from = (page - 1) * per_page;

    let query = this.supabase
      .from("channel_message")
      .select(
        CHANNEL_MESSAGE_COLUMNS,
        { count: "exact" },
      )
      .eq("business_id", businessId)
      .eq("channel", channel)
      .order("created_at", { ascending: false })
      .range(from, from + per_page - 1);

    if (status && status !== "all") query = query.eq("status", status);
    if (search) query = query.ilike("name", `%${search}%`);

    const { data, error, count } = await query;
    if (error) throw error;

    const messages = (data ?? []) as ChannelMessageQueryRecord[];

    // Resolve related records separately (avoids schema-cache join dependency)
    const segmentIds = [
      ...new Set(messages.map((m) => m.segment_id).filter(Boolean)),
    ];
    const templateIds = [
      ...new Set(messages.map((m) => m.template_id).filter(Boolean)),
    ];

    const [segmentsRes, templatesRes] = await Promise.all([
      segmentIds.length > 0
        ? this.supabase.from("segments").select("id, name").in("id", segmentIds)
        : Promise.resolve({ data: [], error: null }),
      templateIds.length > 0
        ? this.supabase
            .from("channel_template")
            .select("id, name, body, wa_template_id")
            .in("id", templateIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    const segmentMap = Object.fromEntries(
      (segmentsRes.data ?? []).map((segment: { id: string; name: string }) => [
        segment.id,
        segment,
      ]),
    );
    const templateMap = Object.fromEntries(
      (templatesRes.data ?? []).map(
        (template: { id: string; name: string; body: string; wa_template_id: string | null }) => [
          template.id,
          template,
        ],
      ),
    );

    const enriched = messages.map((m) => ({
      ...m,
      stats: this.toMessageStats(m),
      segment: m.segment_id ? (segmentMap[m.segment_id] ?? null) : null,
      template: m.template_id ? (templateMap[m.template_id] ?? null) : null,
    }));

    return { messages: enriched, total: count ?? 0, page, per_page };
  }

  async getAggregateStats(businessId: string, channel: ChannelType) {
    const { data: msgs } = await this.supabase
      .from("channel_message")
      .select(
        "id, recipient_count, accepted_count, delivered_count, read_count, replied_count, clicked_count, optout_count, failed_count",
      )
      .eq("business_id", businessId)
      .eq("channel", channel)
      .in("status", ["sent", "partial"]);

    const messages = (msgs ?? []) as AggregateMessageRecord[];
    const totalSent = messages.reduce(
      (sum, message) => sum + (message.accepted_count ?? 0),
      0,
    );

    if (channel === "whatsapp") {
      const { count: optInCount } = await this.supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("whatsapp_opted_in", true);

      const totalDelivered = messages.reduce(
        (sum, message) => sum + (message.delivered_count ?? 0),
        0,
      );
      const totalRead = messages.reduce(
        (sum, message) => sum + (message.read_count ?? 0),
        0,
      );
      const totalReplied = messages.reduce(
        (sum, message) => sum + (message.replied_count ?? 0),
        0,
      );

      return {
        total_sent: totalSent,
        avg_read_rate:
          totalDelivered > 0
            ? Math.round((totalRead / totalDelivered) * 100)
            : 0,
        avg_reply_rate:
          totalDelivered > 0
            ? Math.round((totalReplied / totalDelivered) * 100)
            : 0,
        opted_in_contacts: optInCount ?? 0,
      };
    } else {
      const totalDelivered = messages.reduce(
        (sum, message) => sum + (message.delivered_count ?? 0),
        0,
      );
      const totalClicked = messages.reduce(
        (sum, message) => sum + (message.clicked_count ?? 0),
        0,
      );
      const totalOptOut = messages.reduce(
        (sum, message) => sum + (message.optout_count ?? 0),
        0,
      );

      return {
        total_sent: totalSent,
        avg_delivered_rate:
          totalSent > 0 ? Math.round((totalDelivered / totalSent) * 100) : 0,
        avg_click_rate:
          totalDelivered > 0
            ? Math.round((totalClicked / totalDelivered) * 100)
            : 0,
        opt_out_rate:
          totalSent > 0 ? Math.round((totalOptOut / totalSent) * 100) : 0,
      };
    }
  }

  async getMessage(businessId: string, channel: ChannelType, id: string) {
    const { data, error } = await this.supabase
      .from("channel_message")
      .select(
        CHANNEL_MESSAGE_COLUMNS,
      )
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      const err = Object.assign(new Error("Message not found"), {
        statusCode: 404,
      });
      throw err;
    }

    const msg = data as ChannelMessageQueryRecord;

    const [segRes, tmplRes] = await Promise.all([
      msg.segment_id
        ? this.supabase
            .from("segments")
            .select("id, name")
            .eq("id", msg.segment_id)
            .eq("business_id", businessId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      msg.template_id
        ? this.supabase
            .from("channel_template")
            .select(CHANNEL_TEMPLATE_COLUMNS)
            .eq("id", msg.template_id)
            .eq("business_id", businessId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);

    return {
      ...msg,
      stats: this.toMessageStats(msg),
      segment: segRes.data ?? null,
      template: tmplRes.data ?? null,
    } as ChannelMessage;
  }

  async createMessage(
    businessId: string,
    userId: string,
    channel: ChannelType,
    body: CreateMessageBody,
  ) {
    const { data, error } = await this.supabase
      .from("channel_message")
      .insert({
        business_id: businessId,
        channel,
        name: body.name,
        segment_id: body.segment_id ?? null,
        template_id: body.template_id ?? null,
        body_override: body.body_override ?? null,
        scheduled_at: body.scheduled_at ?? null,
        status: "draft",
        created_by: userId,
      })
      .select(CHANNEL_MESSAGE_COLUMNS)
      .single();

    if (error) throw error;
    return data as ChannelMessage;
  }

  async updateMessage(
    businessId: string,
    channel: ChannelType,
    id: string,
    body: Partial<CreateMessageBody>,
  ) {
    const updates = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.segment_id !== undefined ? { segment_id: body.segment_id } : {}),
      ...(body.template_id !== undefined ? { template_id: body.template_id } : {}),
      ...(body.body_override !== undefined
        ? { body_override: body.body_override }
        : {}),
      ...(body.scheduled_at !== undefined
        ? { scheduled_at: body.scheduled_at }
        : {}),
      updated_at: new Date().toISOString(),
    };
    const { data, error } = await this.supabase
      .from("channel_message")
      .update(updates)
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .eq("status", "draft")
      .select(CHANNEL_MESSAGE_COLUMNS)
      .single();
    if (error) throw error;
    return data as ChannelMessage;
  }

  async deleteMessage(businessId: string, channel: ChannelType, id: string) {
    const { error } = await this.supabase
      .from("channel_message")
      .delete()
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .eq("status", "draft");
    if (error) throw error;
  }

  async sendMessage(
    businessId: string,
    channel: ChannelType,
    id: string,
    opts: { scheduled_at?: string | null } = {},
  ) {
    const msg = await this.getMessage(businessId, channel, id);
    const scheduledAt = this.validateScheduledAt(opts.scheduled_at);
    const body = this.resolveMessageBody(msg, channel);
    const providerName = this.getProviderName(channel);

    await this.claimMessageForPreparation(businessId, channel, id);

    try {
      const { contacts, suppressed } = await this.resolveRecipients(
        channel,
        msg.segment_id,
        businessId,
      );
      if (contacts.length === 0) {
        throw Object.assign(
          new Error(
            channel === "whatsapp"
              ? "No opted-in contacts have valid phone numbers."
              : "No eligible SMS contacts have valid phone numbers.",
          ),
          { statusCode: 400 },
        );
      }

      const deliveries = this.buildDeliveries({
        messageId: id,
        businessId,
        channel,
        body,
        contacts,
      });
      const requiredCredits = deliveries.reduce(
        (total, delivery) => total + delivery.credit_cost,
        0,
      );
      const sendAttemptId = randomUUID();
      const messageParts = Math.max(
        ...deliveries.map((delivery) =>
          calculateChannelCost({
            channel,
            recipientCount: 1,
            body: delivery.body,
          }).messageParts,
        ),
      );

      await this.replaceDeliveries(id, deliveries);
      await this.reserveCredits({
        businessId,
        messageId: id,
        requiredCredits,
        recipientCount: contacts.length,
        messageParts,
        providerName,
        sendAttemptId,
        scheduledAt,
      });

      const queueMessageId = await queueChannelCampaignJob({
        payload: { messageId: id, businessId },
        scheduledAt,
      });
      if (!queueMessageId) {
        await this.refundPreparedMessage(
          businessId,
          id,
          requiredCredits,
          sendAttemptId,
          "queue_unavailable",
        );
        throw Object.assign(
          new Error("Campaign delivery could not be queued. Reserved credits were returned."),
          { statusCode: 503 },
        );
      }

      const { data, error } = await this.supabase
        .from("channel_message")
        .update({
          queue_message_id: queueMessageId,
          suppressed_count: suppressed,
          updated_at: new Date().toISOString(),
        })
        .eq("id", id)
        .eq("business_id", businessId)
        .select(
          CHANNEL_MESSAGE_COLUMNS,
        )
        .single();
      if (error) {
        console.error(
          `[ChannelCampaign] Job ${queueMessageId} queued, but its ID could not be persisted:`,
          error,
        );
        return this.getMessage(businessId, channel, id);
      }
      return data as ChannelMessage;
    } catch (error) {
      await this.restorePreparationFailure(businessId, id);
      throw error;
    }
  }

  async estimateMessageCost(
    businessId: string,
    channel: ChannelType,
    params: { segment_id?: string | null; body: string },
  ) {
    const { contacts, suppressed } = await this.resolveRecipients(
      channel,
      params.segment_id ?? null,
      businessId,
    );
    const estimates = contacts.map((contact) =>
      calculateChannelCost({
        channel,
        recipientCount: 1,
        body: this.interpolate(params.body, contact),
      }),
    );

    return {
      channel,
      recipient_count: contacts.length,
      suppressed_count: suppressed,
      message_parts: estimates.reduce(
        (maximum, estimate) => Math.max(maximum, estimate.messageParts),
        channel === "sms" ? 1 : 1,
      ),
      required_credits: estimates.reduce(
        (total, estimate) => total + estimate.requiredCredits,
        0,
      ),
      includes_opt_out_footer: channel === "sms",
    };
  }

  private validateScheduledAt(value?: string | null): string | null {
    if (!value) return null;
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() <= Date.now()) {
      throw Object.assign(new Error("Scheduled time must be in the future."), {
        statusCode: 400,
      });
    }
    return timestamp.toISOString();
  }

  private resolveMessageBody(message: ChannelMessage, channel: ChannelType): string {
    const body = message.body_override?.trim() || message.template?.body?.trim() || "";
    if (!body) {
      throw Object.assign(new Error("Message body is required."), {
        statusCode: 400,
      });
    }
    return channel === "sms" ? appendSmsOptOutFooter(body) : body;
  }

  private getProviderName(channel: ChannelType): string {
    return (
      (channel === "whatsapp"
        ? process.env.WHATSAPP_PROVIDER
        : process.env.SMS_PROVIDER) ||
      (process.env.NODE_ENV === "production" ? "termii" : "dev")
    ).toLowerCase();
  }

  private async claimMessageForPreparation(
    businessId: string,
    channel: ChannelType,
    messageId: string,
  ): Promise<void> {
    const { data, error } = await this.supabase
      .from("channel_message")
      .update({ status: "preparing", updated_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("business_id", businessId)
      .eq("channel", channel)
      .in("status", ["draft", "scheduled"])
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      throw Object.assign(new Error("This campaign is already being processed."), {
        statusCode: 409,
      });
    }
  }

  private buildDeliveries(params: {
    messageId: string;
    businessId: string;
    channel: ChannelType;
    body: string;
    contacts: ChannelRecipient[];
  }): PreparedDelivery[] {
    return params.contacts.map((contact) => {
      const personalisedBody = this.interpolate(params.body, contact);
      const cost = calculateChannelCost({
        channel: params.channel,
        recipientCount: 1,
        body: personalisedBody,
      });
      return {
        message_id: params.messageId,
        business_id: params.businessId,
        contact_id: contact.id,
        phone: contact.phone,
        body: personalisedBody,
        credit_cost: cost.requiredCredits,
        status: "pending",
      };
    });
  }

  private async replaceDeliveries(
    messageId: string,
    deliveries: PreparedDelivery[],
  ): Promise<void> {
    const { error: deleteError } = await this.supabase
      .from("channel_message_delivery")
      .delete()
      .eq("message_id", messageId);
    if (deleteError) throw deleteError;

    for (let index = 0; index < deliveries.length; index += DELIVERY_INSERT_SIZE) {
      const { error } = await this.supabase
        .from("channel_message_delivery")
        .insert(deliveries.slice(index, index + DELIVERY_INSERT_SIZE));
      if (error) throw error;
    }
  }

  private async reserveCredits(params: {
    businessId: string;
    messageId: string;
    requiredCredits: number;
    recipientCount: number;
    messageParts: number;
    providerName: string;
    sendAttemptId: string;
    scheduledAt: string | null;
  }): Promise<void> {
    const { error } = await this.supabase.rpc("reserve_channel_message_credits", {
      p_business_id: params.businessId,
      p_message_id: params.messageId,
      p_amount: params.requiredCredits,
      p_recipient_count: params.recipientCount,
      p_message_parts: params.messageParts,
      p_provider: params.providerName,
      p_attempt_id: params.sendAttemptId,
      p_scheduled_at: params.scheduledAt,
    });
    if (!error) return;

    if (error.message.includes("INSUFFICIENT_CAMPAIGN_CREDITS")) {
      throw Object.assign(new Error("Insufficient campaign credits for this send."), {
        statusCode: 402,
        code: "INSUFFICIENT_CAMPAIGN_CREDITS",
      });
    }
    throw error;
  }

  private async refundPreparedMessage(
    businessId: string,
    messageId: string,
    amount: number,
    sendAttemptId: string,
    reason: string,
  ): Promise<void> {
    const { error } = await this.supabase.rpc("refund_channel_message_credits", {
      p_business_id: businessId,
      p_message_id: messageId,
      p_attempt_id: sendAttemptId,
      p_amount: amount,
      p_reason: reason,
    });
    if (error) throw error;

    await this.supabase
      .from("channel_message")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("business_id", businessId);
  }

  private async restorePreparationFailure(
    businessId: string,
    messageId: string,
  ): Promise<void> {
    await this.supabase
      .from("channel_message")
      .update({ status: "draft", updated_at: new Date().toISOString() })
      .eq("id", messageId)
      .eq("business_id", businessId)
      .eq("status", "preparing");
  }

  async getMessageStats(businessId: string, channel: ChannelType, id: string) {
    const { error: msgErr } = await this.supabase
      .from("channel_message")
      .select("id")
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .single();
    if (msgErr) throw msgErr;

    const { data, error } = await this.supabase
      .from("channel_message")
      .select(`${CHANNEL_MESSAGE_COLUMNS}`)
      .eq("id", id)
      .maybeSingle();
    if (error) throw error;
    return data ? this.toMessageStats(data as ChannelMessageQueryRecord) : null;
  }

  // ── Templates ────────────────────────────────────────────────────────────────

  async getTemplates(
    businessId: string,
    channel: ChannelType,
    opts: { status?: string; category?: string; search?: string },
  ) {
    let query = this.supabase
      .from("channel_template")
      .select(CHANNEL_TEMPLATE_COLUMNS)
      .eq("business_id", businessId)
      .eq("channel", channel)
      .order("created_at", { ascending: false });

    if (opts.status && opts.status !== "all")
      query = query.eq("status", opts.status);
    if (opts.category) query = query.eq("category", opts.category);
    if (opts.search) query = query.ilike("name", `%${opts.search}%`);

    const { data, error } = await query;
    if (error) throw error;
    return data as ChannelTemplate[];
  }

  async getTemplate(businessId: string, channel: ChannelType, id: string) {
    const { data, error } = await this.supabase
      .from("channel_template")
      .select(CHANNEL_TEMPLATE_COLUMNS)
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .single();
    if (error) throw error;
    return data as ChannelTemplate;
  }

  async createTemplate(
    businessId: string,
    userId: string,
    channel: ChannelType,
    body: CreateTemplateBody,
  ) {
    const insert: Record<string, unknown> = {
      business_id: businessId,
      channel,
      name: body.name,
      category: body.category,
      body: body.body,
      footer: body.footer ?? null,
      buttons: body.buttons ?? [],
      created_by: userId,
      status: channel === "sms" ? "internal" : "draft",
    };

    if (channel === "whatsapp") {
      insert.header_type = body.header_type ?? "none";
      insert.header_content = body.header_content ?? null;
    }

    const { data, error } = await this.supabase
      .from("channel_template")
      .insert(insert)
      .select(CHANNEL_TEMPLATE_COLUMNS)
      .single();
    if (error) throw error;
    return data as ChannelTemplate;
  }

  async updateTemplate(
    businessId: string,
    channel: ChannelType,
    id: string,
    body: Partial<CreateTemplateBody>,
  ) {
    const { data, error } = await this.supabase
      .from("channel_template")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .in("status", ["draft", "rejected"])
      .select(CHANNEL_TEMPLATE_COLUMNS)
      .single();
    if (error) throw error;
    return data as ChannelTemplate;
  }

  async submitTemplate(businessId: string, channel: ChannelType, id: string) {
    if (channel !== "whatsapp")
      throw new Error("Only WhatsApp templates can be submitted.");

    const { error } = await this.supabase
      .from("channel_template")
      .select("id")
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .single();
    if (error) throw error;

    const provider = (process.env.WHATSAPP_PROVIDER ?? "termii").toLowerCase();
    if (provider === "termii") {
      throw new Error(
        "Termii WhatsApp campaigns do not use Meta template submission.",
      );
    }

    throw new Error(
      `WhatsApp template submission is not implemented for provider ${provider}.`,
    );
  }

  async deleteTemplate(businessId: string, channel: ChannelType, id: string) {
    const { error } = await this.supabase
      .from("channel_template")
      .delete()
      .eq("business_id", businessId)
      .eq("channel", channel)
      .eq("id", id)
      .eq("status", "draft");
    if (error) throw error;
  }

  // ── Webhook handlers ─────────────────────────────────────────────────────────

  async handleSmsStop(phone: string, businessId: string) {
    const { error } = await this.supabase
      .from("contacts")
      .update({ sms_opted_out: true })
      .eq("business_id", businessId)
      .filter("phone", "ilike", `%${phone.replace(/\D/g, "")}%`);
    if (error) throw error;
  }

  async updateStats(
    messageId: string,
    updates: Partial<{
      delivered_count: number;
      read_count: number;
      replied_count: number;
      clicked_count: number;
      optout_count: number;
      failed_count: number;
    }>,
  ) {
    const { error } = await this.supabase
      .from("channel_message")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", messageId);
    if (error) throw error;
  }

  private toMessageStats(message: Partial<ChannelMessage>): ChannelMessageStat {
    return {
      id: message.id ?? "",
      message_id: message.id ?? "",
      accepted_count: message.accepted_count ?? 0,
      delivered_count: message.delivered_count ?? 0,
      read_count: message.read_count ?? 0,
      replied_count: message.replied_count ?? 0,
      clicked_count: message.clicked_count ?? 0,
      optout_count: message.optout_count ?? 0,
      failed_count: message.failed_count ?? 0,
      updated_at: message.updated_at ?? new Date(0).toISOString(),
    };
  }
}

export default ChannelService;
