import { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { supabase } from "../config/supabase";
import { AuditService } from "./audit.service";
import { uploadMulterFileToR2 } from "../utils/storage.util";

interface CreateEventOptions {
  imageFile?: { buffer: Buffer; mimetype: string };
  actorUserId?: string;
}

type CheckoutFieldType =
  | "text"
  | "number"
  | "email"
  | "tel"
  | "date"
  | "time"
  | "url"
  | "textarea"
  | "select"
  | "checkbox";
type CheckoutFieldOption = { label: string; value: string };
type CheckoutField = {
  id: string;
  label: string;
  type: CheckoutFieldType;
  required: boolean;
  options?: CheckoutFieldOption[];
  position: number;
};

const CHECKOUT_FIELD_TYPES: CheckoutFieldType[] = [
  "text",
  "number",
  "email",
  "tel",
  "date",
  "time",
  "url",
  "textarea",
  "select",
  "checkbox",
];

/**
 * Schedule fields are nullable: an empty string from the create/edit form must
 * become NULL so the database treats the event as "date to be disclosed" (TBD).
 */
const SCHEDULE_DATE_FIELDS = ["start_date", "start_time", "end_date", "end_time"];

const EVENT_SALES_CHANNELS = ["storefront", "pos", "marketplace"] as const;
type EventSalesChannel = (typeof EVENT_SALES_CHANNELS)[number];

const sanitizeSalesChannels = (raw: unknown): EventSalesChannel[] => {
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("sales_channels must be an array"), {
      statusCode: 400,
    });
  }

  const channels = [...new Set(raw.map(String))];
  const invalidChannel = channels.find(
    (channel) => !EVENT_SALES_CHANNELS.includes(channel as EventSalesChannel),
  );
  if (invalidChannel) {
    throw Object.assign(
      new Error(`Invalid event sales channel: ${invalidChannel}`),
      { statusCode: 400 },
    );
  }
  if (channels.length === 0) {
    throw Object.assign(new Error("At least one sales channel is required"), {
      statusCode: 400,
    });
  }

  return channels as EventSalesChannel[];
};

const normalizeDateField = (value: unknown): string | null =>
  value == null || value === "" ? null : String(value);

const toFieldId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

const sanitizeCheckoutFields = (raw: any): CheckoutField[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw Object.assign(new Error("checkout_fields must be an array"), {
      statusCode: 400,
    });
  }

  const seen = new Set<string>();

  return raw.map((field: any, index: number) => {
    const label = String(field?.label || "").trim();
    if (!label) {
      throw Object.assign(new Error("Checkout field label is required"), {
        statusCode: 400,
      });
    }

    const type = String(field?.type || "text") as CheckoutFieldType;
    if (!CHECKOUT_FIELD_TYPES.includes(type)) {
      throw Object.assign(new Error(`Invalid checkout field type: ${type}`), {
        statusCode: 400,
      });
    }

    const normalizedId = toFieldId(String(field?.id || label));
    if (!normalizedId) {
      throw Object.assign(new Error(`Invalid checkout field id for label: ${label}`), {
        statusCode: 400,
      });
    }

    if (seen.has(normalizedId)) {
      throw Object.assign(new Error(`Duplicate checkout field id: ${normalizedId}`), {
        statusCode: 400,
      });
    }
    seen.add(normalizedId);

    const options =
      type === "select"
        ? (Array.isArray(field?.options) ? field.options : [])
            .map((opt: any) => ({
              label: String(opt?.label || "").trim(),
              value: toFieldId(String(opt?.value || opt?.label || "")),
            }))
            .filter((opt: CheckoutFieldOption) => opt.label && opt.value)
        : [];

    if (type === "select" && options.length === 0) {
      throw Object.assign(
        new Error(`Select field "${label}" must have at least one option`),
        { statusCode: 400 },
      );
    }

    return {
      id: normalizedId,
      label,
      type,
      required: field?.required !== false,
      options: type === "select" ? options : [],
      position: index,
    };
  });
};

const ADJUSTMENT_TYPES = ["surcharge", "discount"];
const ADJUSTMENT_MODES = ["flat", "percent"];
const APPLIES_TO = ["per_attendee", "per_order"];

const badRule = (message: string) =>
  Object.assign(new Error(message), { statusCode: 400 });

export const sanitizePricingRules = (raw: any): any[] => {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw badRule("pricing_rules must be an array");
  }

  return raw.map((rule: any) => {
    const conditionType = String(rule?.condition?.type || "").trim();
    if (!conditionType) throw badRule("Pricing rule condition.type is required");
    if (
      conditionType === "segment_membership" &&
      !String(rule?.condition?.segment_id || "").trim()
    ) {
      throw badRule("segment_membership rules require a segment_id");
    }
    if (
      conditionType === "coupon_code" &&
      !String(rule?.condition?.code || "").trim()
    ) {
      throw badRule("coupon_code rules require a code");
    }

    const adjustmentType = String(rule?.adjustment?.type || "");
    const adjustmentMode = String(rule?.adjustment?.mode || "");
    if (!ADJUSTMENT_TYPES.includes(adjustmentType)) {
      throw badRule(`Invalid adjustment type: ${adjustmentType}`);
    }
    if (!ADJUSTMENT_MODES.includes(adjustmentMode)) {
      throw badRule(`Invalid adjustment mode: ${adjustmentMode}`);
    }
    const amount = Number(rule?.adjustment?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      throw badRule("Pricing rule adjustment.amount must be a positive number");
    }

    const appliesTo = String(rule?.applies_to || "per_attendee");
    if (!APPLIES_TO.includes(appliesTo)) {
      throw badRule(`Invalid applies_to: ${appliesTo}`);
    }

    const cap = rule?.redemption?.cap;
    const redemption =
      cap != null && Number.isInteger(cap) && cap > 0 ? { cap } : null;

    return {
      id: String(rule?.id || randomUUID()),
      active: rule?.active !== false,
      condition: { ...rule.condition, type: conditionType },
      adjustment: { type: adjustmentType, mode: adjustmentMode, amount },
      applies_to: appliesTo,
      redemption,
      message: String(rule?.message || "").trim(),
    };
  });
};

export class EventService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Create a new event with optional tickets, cover image, and audit logging.
   */
  async createEvent(
    data: any,
    businessId: string,
    options?: CreateEventOptions,
  ) {
    // Extract tickets before cleaning the data object
    const tickets = data.tickets || [];

    // Clean data: remove fields that don't exist in the events table
    const cleanedData = { ...data };
    delete cleanedData.tickets;
    delete cleanedData.owner;
    delete cleanedData.creator_subaccount_code;
    delete cleanedData.attendeesCount;
    delete cleanedData.recent_attendees;
    // We keep event_sessions and event_speakers as they are now columns in the table
    cleanedData.checkout_fields = sanitizeCheckoutFields(
      cleanedData.checkout_fields,
    );
    cleanedData.pricing_rules = sanitizePricingRules(cleanedData.pricing_rules);
    cleanedData.sales_channels = sanitizeSalesChannels(
      cleanedData.sales_channels ?? ["storefront"],
    );

    // 1. Ensure required fields have safe defaults. Dates are nullable — a
    // NULL start_date means the event date is "to be disclosed" (TBD), so
    // never coerce a missing date to today.
    const eventToInsert = {
      ...cleanedData,
      business_id: businessId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: cleanedData.status || "draft",
      timezone: cleanedData.timezone || "UTC+01:00 West Central Africa",
      event_type: cleanedData.event_type || "single",
      is_physical: cleanedData.is_physical ?? false,
      is_online: cleanedData.is_online ?? true,
      start_date: normalizeDateField(cleanedData.start_date),
      start_time: normalizeDateField(cleanedData.start_time),
      end_date: normalizeDateField(cleanedData.end_date),
      end_time: normalizeDateField(cleanedData.end_time),
      // Handle event_url unique constraint: empty string should be null
      event_url:
        cleanedData.event_url?.trim() === ""
          ? null
          : cleanedData.event_url || null,
    };

    // 2. Create the event
    const { data: eventData, error } = await this.supabase
      .from("events")
      .insert([eventToInsert])
      .select()
      .single();

    if (error) {
      console.error("[EventService.createEvent] Database error:", error);
      throw error;
    }

    // 2. Upload cover image if provided
    if (options?.imageFile) {
      const key = `events/${eventData.id}/cover_image`;
      const coverImageUrl = await uploadMulterFileToR2(options.imageFile as Express.Multer.File, key);
      await this.updateEvent(eventData.id, { cover_image: coverImageUrl });
      eventData.cover_image = coverImageUrl;
    }

    // 3. Insert tickets if provided
    let savedTickets: any[] = [];
    if (tickets.length > 0) {
      const { data: ticketsData, error: ticketError } = await this.supabase
        .from("event_tickets")
        .insert(tickets.map((t: any) => ({ ...t, event_id: eventData.id })))
        .select();

      if (ticketError) throw ticketError;
      savedTickets = ticketsData || [];
    }

    // 4. Log audit event
    if (options?.actorUserId) {
      const auditService = new AuditService(this.supabase);
      await auditService.log({
        businessId,
        actorUserId: options.actorUserId,
        action: "EVENT_CREATED",
        targetType: "event",
        targetId: eventData.id,
        metadata: { name: eventData.event_name },
      });
    }

    return { ...eventData, tickets: savedTickets };
  }

  async getEvent(identifier: string) {
    const isUUID =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        identifier,
      );

    const query = this.supabase
      .from("events")
      .select(
        "*, owner:owner_id(*), business:business_id(id, name, slug, logo_url), attendeesCount:issued_tickets(count)",
      );

    const result = isUUID
      ? await query.eq("id", identifier).single()
      : await query.eq("event_url", identifier).single();

    if (result.error) throw result.error;
    return result.data;
  }

  async getPublicOrderByReference(reference: string) {
    const { supabaseAdmin } = await import("../config/supabase");

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("*, event:event_id(*)")
      .eq("payment_reference", reference)
      .maybeSingle();

    if (error) {
      console.error("Error fetching event order by reference", error);
      throw error;
    }

    return order;
  }

  async getPublicTicketsByOrderId(orderId: string) {
    const { supabaseAdmin } = await import("../config/supabase");

    const { data: tickets, error } = await supabaseAdmin
      .from("issued_tickets")
      .select("*, event:event_id(*)")
      .or(`order_id.eq.${orderId},id.eq.${orderId}`);

    if (error) {
      console.error("Error fetching event tickets by order ID", error);
      throw error;
    }

    return tickets;
  }

  /**
   * Update an event with optional ticket sync and cover image update.
   */
  async updateEvent(
    id: string,
    updates: any,
    options?: {
      imageFile?: { buffer: Buffer; mimetype: string };
      tickets?: any[];
    },
  ) {
    // Clean updates: remove fields that don't exist in the events table
    const cleanedUpdates = { ...updates };
    delete cleanedUpdates.tickets;
    delete cleanedUpdates.owner;
    delete cleanedUpdates.creator_subaccount_code;
    delete cleanedUpdates.attendeesCount;
    delete cleanedUpdates.recent_attendees;
    delete cleanedUpdates.business;
    // We keep event_sessions and event_speakers as they are now columns in the table
    if (Object.prototype.hasOwnProperty.call(cleanedUpdates, "checkout_fields")) {
      cleanedUpdates.checkout_fields = sanitizeCheckoutFields(
        cleanedUpdates.checkout_fields,
      );
    }
    if (Object.prototype.hasOwnProperty.call(cleanedUpdates, "pricing_rules")) {
      cleanedUpdates.pricing_rules = sanitizePricingRules(
        cleanedUpdates.pricing_rules,
      );
    }
    if (Object.prototype.hasOwnProperty.call(cleanedUpdates, "sales_channels")) {
      cleanedUpdates.sales_channels = sanitizeSalesChannels(
        cleanedUpdates.sales_channels,
      );
    }

    // 1. Handle cover image update if provided
    if (options?.imageFile) {
      const key = `events/${id}/cover_image_${randomUUID()}`;
      cleanedUpdates.cover_image = await uploadMulterFileToR2(options.imageFile as Express.Multer.File, key);
    }

    // 2. Update the event
    if (cleanedUpdates.event_url?.trim() === "") {
      cleanedUpdates.event_url = null;
    }
    for (const field of SCHEDULE_DATE_FIELDS) {
      if (
        Object.prototype.hasOwnProperty.call(cleanedUpdates, field) &&
        cleanedUpdates[field] === ""
      ) {
        cleanedUpdates[field] = null;
      }
    }

    const { data: eventData, error } = await this.supabase
      .from("events")
      .update({
        ...cleanedUpdates,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id)
      .select()
      .single();

    if (error) {
      console.error("[EventService.updateEvent] Database error:", error);
      throw error;
    }

    // 3. Sync tickets if provided
    let updatedTickets: any[] = [];
    if (options?.tickets && options.tickets.length > 0) {
      const { data: existingTickets } = await this.supabase
        .from("event_tickets")
        .select()
        .eq("event_id", id);

      const existing = existingTickets || [];
      const ticketsToUpdate = options.tickets.filter((t: any) =>
        existing.some((ex: any) => ex.id === t.id),
      );
      const ticketsToAdd = options.tickets.filter(
        (t: any) => !t.id || !existing.some((ex: any) => ex.id === t.id),
      );
      const ticketsToDelete = existing.filter(
        (ex: any) => !options.tickets!.some((t: any) => t.id === ex.id),
      );

      // Delete removed tickets
      if (ticketsToDelete.length > 0) {
        await this.supabase
          .from("event_tickets")
          .delete()
          .in(
            "id",
            ticketsToDelete.map((t: any) => t.id),
          );
      }

      // Update existing tickets
      for (const ticket of ticketsToUpdate) {
        await this.supabase
          .from("event_tickets")
          .update({ ...ticket, updated_at: new Date().toISOString() })
          .eq("id", ticket.id);
      }

      // Add new tickets
      if (ticketsToAdd.length > 0) {
        await this.supabase
          .from("event_tickets")
          .insert(ticketsToAdd.map((t: any) => ({ ...t, event_id: id })));
      }

      // Fetch updated tickets
      const { data: refreshedTickets } = await this.supabase
        .from("event_tickets")
        .select()
        .eq("event_id", id)
        .order("created_at", { ascending: true });

      updatedTickets = refreshedTickets || [];
    }

    return options?.tickets
      ? { ...eventData, tickets: updatedTickets }
      : eventData;
  }

  async deleteEvent(id: string) {
    // Delete tickets first due to FK
    await this.supabase.from("event_tickets").delete().eq("event_id", id);
    const { error } = await this.supabase.from("events").delete().eq("id", id);
    if (error) throw error;
  }

  /**
   * Duplicate an event into a fresh draft. Copies the source row and its
   * tickets, then resets identity, publishing state, and the unique event_url.
   */
  async duplicateEvent(
    eventId: string,
    businessId: string,
    options?: CreateEventOptions,
  ) {
    const { data: source, error } = await this.supabase
      .from("events")
      .select("*")
      .eq("id", eventId)
      .eq("business_id", businessId)
      .single();

    if (error) throw error;
    if (!source) {
      throw Object.assign(new Error("Event not found"), { statusCode: 404 });
    }

    const { data: sourceTickets, error: ticketError } = await this.supabase
      .from("event_tickets")
      .select("*")
      .eq("event_id", eventId);

    if (ticketError) throw ticketError;

    // Strip DB identity columns so the copied tickets get a fresh event_id.
    const clonedTickets = (sourceTickets || []).map(
      ({ id: _id, event_id: _eventId, created_at: _ca, updated_at: _ua, ...ticket }) => ticket,
    );

    // Build the duplicate payload. createEvent sanitizes fields, inserts the
    // tickets, and logs the audit trail.
    const duplicatePayload = {
      ...source,
      event_name: `${source.event_name} (Copy)`,
      event_url: null, // event_url is unique — a copy must start unsluggified
      status: "draft",
      publish_date: null,
      is_sales_active: false,
      tickets: clonedTickets,
    };
    // Destructure out identity/timestamps so they are never sent to the DB —
    // spreading `id: undefined` would serialize as null and violate NOT NULL.
    delete duplicatePayload.id;
    delete duplicatePayload.created_at;
    delete duplicatePayload.updated_at;

    return this.createEvent(duplicatePayload, businessId, options);
  }

  async getAttendees(
    event_id: string,
  ): Promise<Array<{ customer_email: string }>> {
    const { data: attendees, error } = await this.supabase
      .from("issued_tickets")
      .select("customer_email")
      .eq("event_id", event_id);

    if (error) throw error;
    return (attendees as any[]) || [];
  }

  async attendEvent(eventId: string, userId: string, data: any) {
    // Logic for joining an event. This typically involves creating an order and an issued ticket.
    // Assuming a simple "join" for now that creates an issued ticket if it's a free event or similar.
    const { data: ticket, error } = await this.supabase
      .from("issued_tickets")
      .insert({
        event_id: eventId,
        user_id: userId, // Assuming user_id is tracked
        customer_email: data.email,
        customer_name: data.name,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    return ticket;
  }

  async checkIn(eventId: string, ticketId: string) {
    const { data, error } = await this.supabase
      .from("issued_tickets")
      .update({
        checked_in: true,
        checked_in_at: new Date().toISOString(),
      })
      .eq("id", ticketId)
      .eq("event_id", eventId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }
}

export default EventService;
