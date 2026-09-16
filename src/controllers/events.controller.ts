import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import ApiResponse from "../utils/apiResponse";
import { EventService } from "../services/events.services";
import { SUPPORTED_CURRENCIES } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { resolvePaymentAmount } from "../utils/currency-rates.util";
import {
  deriveFlutterwaveMerchantShare,
  resolveCustomerCharge,
} from "../utils/payment/fees";
import type { FeeBearer } from "../types/payment";
import { AuditService } from "../services/audit.service";
import { supabase as publicSupabase } from "../config/supabase";
import supabaseAdmin from "../config/supabaseAdmin";
import { generateEventTicketICS } from "../utils/ics-generator";
import { isEventDateTbd } from "../utils";
import { SupabaseClient } from "@supabase/supabase-js";
import CRMService from "../services/crm.service";
import {
  computeAttendeePricing,
  assertAttendeeEmailsCoverSeats,
  rulesRequireAttendeeEmails,
  isCouponApplied,
  summarizePricingAdjustments,
  type PricingRule,
  type AttendeePricingResult,
} from "../utils/event-pricing";

const COUPON_DISCOUNT_MAX_RATIO = 0.8;

/**
 * @desc  Create a new event and its tickets
 * @access private
 * @endpoint /api/events/create
 */
export const createEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const event = JSON.parse(req.body.event);
    const imageFile = req.file;
    const businessId =
      (req as any).businessId ||
      event.business_id ||
      req.body.business_id ||
      req.query.business_id;

    if (!event.event_name) {
      return res.status(400).json({ error: "Event name is required" });
    }

    const service = new EventService(req.supabase!);
    const eventData = await service.createEvent(event, businessId, {
      imageFile: imageFile
        ? { buffer: imageFile.buffer, mimetype: imageFile.mimetype }
        : undefined,
      actorUserId: (req as any).user_id,
    });

    return res.status(201).json({
      success: true,
      message: "Event created successfully",
      data: eventData,
    });
  } catch (error: any) {
    console.error("Error creating event:", error);
    return res.status(error?.statusCode || 500).json({
      error: "Failed to create event",
      details: error?.message,
    });
  }
};

/**
 * @desc Duplicate an existing event (event + tickets) into a new draft
 * @access private
 * @endpoint POST /api/dashboard/events/:id/duplicate
 */
export const duplicateEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const eventId = req.params.id;
    const businessId =
      (req as any).businessId ||
      req.body.business_id ||
      req.query.business_id;

    if (!businessId) {
      return res.status(400).json({ error: "Business context required" });
    }

    const service = new EventService(req.supabase!);
    const eventData = await service.duplicateEvent(eventId, businessId, {
      actorUserId: (req as any).user_id,
    });

    return res.status(201).json({
      success: true,
      message: "Event duplicated successfully",
      data: eventData,
    });
  } catch (error: any) {
    console.error("Error duplicating event:", error);
    return res.status(error?.statusCode || 500).json({
      error: "Failed to duplicate event",
      details: error?.message,
    });
  }
};

/**
 * @desc Check whether an event_url slug is available
 * @access public
 * @endpoint GET /api/events/check-url?event_url=my-event&exclude_id=optional-event-id
 */
export const checkEventUrl = async (req: SupabaseRequest, res: Response) => {
  try {
    const { event_url, exclude_id } = req.query as {
      event_url?: string;
      exclude_id?: string;
    };

    if (!event_url?.trim()) {
      return ApiResponse.error(res, "event_url query param is required");
    }

    const supabaseClient = req.supabase || publicSupabase;
    let query = supabaseClient
      .from("events")
      .select("id")
      .eq("event_url", event_url.trim())
      .limit(1);

    if (exclude_id) {
      query = query.neq("id", exclude_id);
    }

    const { data, error } = await query;
    if (error) throw error;

    return ApiResponse.success(res, "URL checked", {
      available: !data || data.length === 0,
    });
  } catch (error: any) {
    console.error("Error checking event URL:", error);
    return ApiResponse.error(res, "Failed to check URL", 500);
  }
};

/**
 * @desc Get a single event with its tickets
 * @access public
 * @endpoint /api/events/:id
 */
export const getEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const { id: eventIdentifier } = req.params;
    const supabaseClient = req.supabase || publicSupabase;
    const service = new EventService(supabaseClient);

    const event = await service.getEvent(eventIdentifier);

    const { data: tickets } = await supabaseClient
      .from("event_tickets")
      .select()
      .eq("event_id", event.id)
      .order("ticket_price", { ascending: true });

    // Resolve subaccount with priority: business → owner fallback
    let creatorSubaccountCode: string | undefined;

    // Use admin client to bypass RLS for subaccount resolution
    const { supabaseAdmin } = await import("../config/supabase");

    // Check business level first
    if (event.business_id) {
      const { data: business } = await supabaseAdmin
        .from("businesses")
        .select("paystack_subaccount_code")
        .eq("id", event.business_id)
        .single();

      creatorSubaccountCode = business?.paystack_subaccount_code;
    }

    const { data: issuedTickets } = await publicSupabase
      .from("issued_tickets")
      .select("customer_name")
      .eq("event_id", event.id)
      .limit(5);

    return res.status(200).json({
      success: true,
      data: {
        ...event,
        attendeesCount: event?.attendeesCount?.[0]?.count || 0,
        tickets: tickets || [],
        creator_subaccount_code: creatorSubaccountCode,
        recent_attendees: issuedTickets || [],
      },
    });
  } catch (error: any) {
    console.error("Error fetching event:", error);
    if (error?.code === "PGRST116") {
      return res.status(404).json({ error: "Event not found" });
    }
    return res
      .status(500)
      .json({ error: "Failed to fetch event", details: error?.message });
  }
};

/**
 * @desc Get all events with their tickets
 * @access public
 * @endpoint /api/events
 */
export const getAllEvents = async (req: SupabaseRequest, res: Response) => {
  try {
    const {
      tab = "all",
      search = "",
      category = "",
    } = req.query as {
      tab?: string;
      search?: string;
      category?: string;
    };
    let query = publicSupabase
      .from("events")
      .select(
        "*, owner:owner_id(id, marketplace_visibility), business:business_id(marketplace_visibility)",
      )
      .eq("status", "published")
      .eq("marketplace_hidden", false);

    if (category) {
      query = query.eq("category", category);
    }

    if (search) {
      query = query.or(
        `event_name.ilike.%${search}%,event_description.ilike.%${search}%`,
      );
    }

    const { data: events, error: eventError } = await query.order(
      "created_at",
      {
        ascending: false,
      },
    );

    if (eventError) throw eventError;

    const visibleEvents = (events || []).filter((event: any) => {
      // 1. If it belongs to a business, check business visibility
      if (event.business) {
        return event.business.marketplace_visibility !== false;
      }
      // 2. Fallback to owner visibility for personal events
      return event.owner?.marketplace_visibility !== false;
    });

    const { data: tickets } = await publicSupabase
      .from("event_tickets")
      .select();

    const today = new Date();
    const filteredEvents = visibleEvents.filter((event: any) => {
      // No date yet (TBD) — treat as upcoming until a date is disclosed.
      if (!event.start_date) return tab !== "past";
      const endDate = new Date(event.end_date);
      const endDatePlusOne = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
      // Events without a date are still upcoming: they are published but
      // have not been scheduled yet, so keep them in the upcoming feed.
      if (tab === "upcoming") return !event.end_date || endDatePlusOne >= today;
      if (tab === "past") return endDatePlusOne < today;
      return true;
    });

    const eventsWithTickets = filteredEvents.map((event: any) => ({
      ...event,
      tickets: (tickets || []).filter(
        (ticket: any) => ticket.event_id === event.id,
      ),
    }));

    return res.status(200).json({ success: true, data: eventsWithTickets });
  } catch (error: any) {
    console.error("Error fetching events:", error);
    return res
      .status(500)
      .json({ error: "Failed to fetch events", details: error?.message });
  }
};

/**
 * @desc Get public order by payment reference
 * @access public
 * @endpoint /api/events/public/order/:reference
 */
export const getPublicOrderByReference = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const { reference } = req.params;
    const service = new EventService(publicSupabase);

    const order = await service.getPublicOrderByReference(reference);

    if (!order) {
      return ApiResponse.notFound(res, "Order not found or invalid reference");
    }

    return ApiResponse.success(res, "Order retrieved successfully", order);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: "LOAD_ORDER_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Get public tickets by order ID
 * @access public
 * @endpoint /api/events/public/tickets/:orderId
 */
export const getPublicTicketsByOrderId = async (
  req: SupabaseRequest,
  res: Response,
) => {
  try {
    const { orderId } = req.params;
    const service = new EventService(publicSupabase);
    const tickets = await service.getPublicTicketsByOrderId(orderId);

    if (!tickets || tickets.length === 0) {
      return ApiResponse.notFound(res, "No tickets found for this order");
    }

    return ApiResponse.success(res, "Tickets retrieved successfully", tickets);
  } catch (err: any) {
    const status = err?.statusCode || 500;
    return res.status(status).json({
      success: false,
      error: "LOAD_TICKETS_ERROR",
      message: err.message,
    });
  }
};

/**
 * @desc Download ICS calendar file for an event
 * @access public
 * @endpoint /api/events/public/event/:eventId/calendar
 */
export const getPublicEventCalendar = async (req: SupabaseRequest, res: Response) => {
  try {
    const { eventId } = req.params;

    if (!supabaseAdmin) {
      return ApiResponse.error(res, "Service unavailable", 503);
    }

    const { data: event, error } = await supabaseAdmin
      .from("events")
      .select("event_name, start_date, start_time, end_date, end_time, venue, is_physical")
      .eq("id", eventId)
      .single();

    if (error || !event) {
      return ApiResponse.notFound(res, "Event not found");
    }

    // No date yet (TBD) — an ICS file needs concrete date/time, so there is
    // nothing to download until the organiser discloses the date.
    if (isEventDateTbd(event.start_date)) {
      return ApiResponse.notFound(res, "Event date not yet disclosed");
    }

    const venue = event.is_physical
      ? ((event.venue as any)?.placeDesc ?? (event.venue as any)?.full_address ?? undefined)
      : "Online Event";

    const icsContent = generateEventTicketICS({
      eventName: event.event_name,
      startDate: event.start_date,
      startTime: event.start_time || "00:00",
      endDate: event.end_date || undefined,
      endTime: event.end_time || undefined,
      venue,
      organizerEmail: "events@hilaq.com",
    });

    const filename = `${event.event_name.replace(/[^a-z0-9]/gi, "-").toLowerCase()}.ics`;
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return res.send(icsContent);
  } catch (err: any) {
    return ApiResponse.serverError(res, err.message);
  }
};

/**
 * @desc Update an event and its tickets
 * @access private
 * @endpoint /api/events/:id/update
 */
export const updateEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const { id } = req.params;
    const event = JSON.parse(req.body.event);
    const imageFile = req.file;
    const event_tickets = event.tickets;

    const service = new EventService(req.supabase!);
    const eventData = await service.updateEvent(id, event, {
      imageFile: imageFile
        ? { buffer: imageFile.buffer, mimetype: imageFile.mimetype }
        : undefined,
      tickets: event_tickets,
    });

    return res.status(200).json({
      success: true,
      message: "Event updated successfully",
      data: eventData,
    });
  } catch (error: any) {
    console.error("Error updating event:", error);
    return res
      .status(error?.statusCode || 500)
      .json({ error: "Failed to update event", details: error?.message });
  }
};

/**
 * @desc Delete an event and its tickets
 * @access private
 * @endpoint /api/events/:id/delete
 */
export const deleteEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const { id } = req.params;
    const db = req.supabase!;
    const service = new EventService(db);

    // Fetch event for audit log & businessId
    const event = await service.getEvent(id);
    const businessId = event.business_id;

    await service.deleteEvent(id);

    // Audit Log
    const auditService = new AuditService(db);
    await auditService.log({
      businessId,
      actorUserId: (req as any).user_id,
      action: "EVENT_DELETED",
      targetType: "event",
      targetId: id,
      metadata: { name: event.event_name },
    });

    return res
      .status(200)
      .json({ success: true, message: "Event deleted successfully" });
  } catch (error: any) {
    console.error("Error deleting event:", error);
    return res
      .status(500)
      .json({ error: "Failed to delete event", details: error?.message });
  }
};

/**
 * @desc Join/Register for an event
 * @access private
 * @endpoint POST /api/events/:id/attend
 */
export const attendEvent = async (req: SupabaseRequest, res: Response) => {
  try {
    const { id: eventId } = req.params;
    const { email, name } = req.body;
    const userId = req.user_id!;
    const db = req.supabase!;

    if (!email || !name) {
      return res.status(400).json({ error: "Email and name are required" });
    }

    const service = new EventService(db);
    const ticket = await service.attendEvent(eventId, userId, { email, name });

    return res.status(201).json({
      success: true,
      message: "Successfully registered for event",
      data: ticket,
    });
  } catch (error: any) {
    console.error("Error attending event:", error);
    return res.status(500).json({
      error: "Failed to join event",
      details: error?.message,
    });
  }
};

/**
 * @desc Record attendance (Admin/Facilitator only)
 * @access private
 * @endpoint POST /api/events/check-in
 */
export const checkIn = async (req: SupabaseRequest, res: Response) => {
  try {
    const { event_id, ticket_id } = req.body;
    const userId = req.user_id!;
    const db = req.supabase!;

    if (!event_id || !ticket_id) {
      return res
        .status(400)
        .json({ error: "event_id and ticket_id are required" });
    }

    const service = new EventService(db);

    // Check permission - Only the event owner can check in
    const event = await service.getEvent(event_id);
    if (event.owner_id !== userId) {
      return res
        .status(403)
        .json({ error: "Only the event owner can record attendance" });
    }

    const updatedTicket = await service.checkIn(event_id, ticket_id);

    return res.status(200).json({
      success: true,
      message: "Attendance recorded successfully",
      data: updatedTicket,
    });
  } catch (error: any) {
    console.error("Error recording attendance:", error);
    return res.status(500).json({
      error: "Failed to record attendance",
      details: error?.message,
    });
  }
};

/**
 * Upload event image
 * POST /api/events/upload/image
 */
export const uploadEventImage = async (req: SupabaseRequest, res: Response) => {
  if (!req.file) {
    return ApiResponse.badRequest(res, "No file uploaded");
  }

  try {
    const db = req.supabase!;
    const { businessId, eventId } = req.body;

    if (!businessId || !eventId) {
      return ApiResponse.badRequest(res, "businessId and eventId are required");
    }

    const fileExt = req.file.originalname.split(".").pop();
    const fileName = `event_${Date.now()}.${fileExt}`;
    const filePath = `events/${businessId}/${eventId}/${fileName}`;

    const { StorageService } = await import("../services/storage.service");
    const storageService = new StorageService();
    const result = await storageService.uploadFile(
      "events",
      filePath,
      req.file,
    );

    return ApiResponse.success(
      res,
      "Event image uploaded successfully",
      result,
    );
  } catch (error: any) {
    console.error("[uploadEventImage] Error:", error);
    return ApiResponse.serverError(res, error.message);
  }
};

/**
 * @desc  Initiate a payment for event tickets — supports NGN (Paystack) + GHS/KES/ZAR/USD (Flutterwave)
 * @access public
 * @endpoint POST /api/events/:id/initiate-payment
 */
type EventRecipient = { email?: string; ticketId: string };

function activePricingRules(event: { pricing_rules?: unknown }): PricingRule[] {
  const rules = Array.isArray(event?.pricing_rules) ? event.pricing_rules : [];
  return (rules as PricingRule[]).filter((rule) => rule?.active);
}

async function loadMemberEmailsBySegment(
  db: SupabaseClient,
  businessId: string,
  rules: PricingRule[],
): Promise<Record<string, Set<string>>> {
  const segmentIds = Array.from(
    new Set(
      rules
        .filter((rule) => rule.condition.type === "segment_membership")
        .map((rule) => String(rule.condition.segment_id)),
    ),
  );
  if (segmentIds.length === 0) return {};

  const crmService = new CRMService(db);
  const bySegment: Record<string, Set<string>> = {};
  for (const segmentId of segmentIds) {
    bySegment[segmentId] = await crmService.getSegmentMemberEmails(
      businessId,
      segmentId,
    );
  }
  return bySegment;
}

async function loadPriorMemberRedemptions(
  db: SupabaseClient,
  eventId: string,
): Promise<Record<string, number>> {
  const { data, error } = await db
    .from("issued_tickets")
    .select("customer_email")
    .eq("event_id", eventId)
    .eq("pricing_tier", "member");
  if (error) throw error;

  const counts: Record<string, number> = {};
  for (const row of data || []) {
    const email = (row.customer_email as string | null)?.toLowerCase();
    if (!email) continue;
    counts[email] = (counts[email] || 0) + 1;
  }
  return counts;
}

/**
 * Resolves the per-seat price of an order against the event's pricing rules.
 * Member lookups and redemption counts run with the passed (service-role)
 * client because public buyers can't read CRM/issued_tickets under RLS.
 */
async function resolveOrderPricing(params: {
  db: SupabaseClient;
  event: { id: string; business_id: string; pricing_rules?: unknown };
  tickets: { id: string; ticket_price: number }[];
  buyerEmail: string;
  selectedTickets: Record<string, number>;
  recipients: EventRecipient[];
  couponCode?: string;
}): Promise<AttendeePricingResult> {
  const rules = activePricingRules(params.event);

  const memberEmailsBySegment = await loadMemberEmailsBySegment(
    params.db,
    params.event.business_id,
    rules,
  );
  const priorRedemptionsByEmail = rules.some(
    (rule) => rule.redemption?.cap != null,
  )
    ? await loadPriorMemberRedemptions(params.db, params.event.id)
    : {};

  return computeAttendeePricing({
    tickets: params.tickets,
    selectedTickets: params.selectedTickets,
    buyerEmail: params.buyerEmail,
    recipients: params.recipients,
    rules,
    memberEmailsBySegment,
    priorRedemptionsByEmail,
    couponCode: params.couponCode,
  });
}

async function savePricingSnapshot(params: {
  db: SupabaseClient;
  reference: string;
  eventId: string;
  currency: string;
  pricing: AttendeePricingResult;
}): Promise<void> {
  const { error } = await params.db.from("event_pricing_snapshots").insert({
    reference: params.reference,
    event_id: params.eventId,
    breakdown: params.pricing.breakdown,
    base_total: params.pricing.baseTotal,
    adjustment_total: params.pricing.adjustmentTotal,
    currency: params.currency,
  });
  if (error) throw error;
}

export const initiateEventPayment = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id: eventId } = req.params;
  const {
    email,
    name,
    phone_number,
    gender,
    custom_answers,
    selectedTickets,
    currency = "NGN",
    event_redirect_url,
    recipients,
    coupon_code,
  } = req.body as {
    email: string;
    name?: string;
    phone_number?: string;
    gender?: string;
    custom_answers?: Record<string, string>;
    selectedTickets: Record<string, number>;
    currency?: string;
    event_redirect_url?: string;
    coupon_code?: string;
    recipients?: Array<{
      email: string;
      full_name: string;
      phone_number?: string;
      custom_answers?: Record<string, string>;
      gender?: string;
      ticketId: string;
    }>;
  };

  if (!email || !selectedTickets || !Object.keys(selectedTickets).length) {
    return ApiResponse.error(res, "email and selectedTickets are required");
  }

  try {
    const supabaseClient = req.supabase ?? publicSupabase;

    // Fetch event + tickets
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select(
        "id, business_id, fee_payer, redirect_url, pricing_rules, event_tickets(*)",
      )
      .eq("id", eventId)
      .single();

    if (eventError || !event) {
      console.log("Event error:", eventError);
      return ApiResponse.error(res, "Event not found");
    }

    const tickets: any[] = Array.isArray(event.event_tickets) ? event.event_tickets : [];

    // Price per attendee against the event's pricing rules. Member lookups and
    // redemption counts need the service role to bypass RLS for public buyers.
    const orderRecipients = (recipients ?? []) as EventRecipient[];
    const pricingRules = activePricingRules(event);
    if (rulesRequireAttendeeEmails(pricingRules)) {
      assertAttendeeEmailsCoverSeats(selectedTickets, orderRecipients);
    }

    // Pricing rules need the service role for privileged reads + snapshot write;
    // the anon fallback would silently misprice the order, so refuse loudly.
    if (pricingRules.length > 0 && !supabaseAdmin) {
      console.error(
        "[initiateEventPayment] SUPABASE_SERVICE_ROLE_KEY is missing; cannot price an event with pricing rules using the anon client. Set the service-role key in the backend environment.",
      );
      return ApiResponse.error(
        res,
        "We couldn't process your order right now due to a temporary issue on our end. Please try again in a few minutes, or contact the event organiser if the problem persists.",
        503,
      );
    }

    const pricingDb = supabaseAdmin ?? supabaseClient;
    const pricing = await resolveOrderPricing({
      db: pricingDb,
      event,
      tickets,
      buyerEmail: email,
      selectedTickets,
      recipients: orderRecipients,
      couponCode: coupon_code,
    });
    const totalAmount = pricing.baseTotal + pricing.adjustmentTotal;

    if (totalAmount === 0) {
      return ApiResponse.error(
        res,
        "Use the free ticket endpoint (/webhook/paystack/free) for zero-cost orders",
      );
    }

    const { PaymentProviderFactory } =
      await import("../utils/payment/PaymentProviderFactory");

    const safeCurrency: SupportedCurrency = (
      SUPPORTED_CURRENCIES as readonly string[]
    ).includes(currency)
      ? (currency as SupportedCurrency)
      : "NGN";

    // Fetch subaccounts and fee bearer from business — events don't store these directly
    let flwSubaccountId: string | undefined;
    let paystackSubaccountCode: string | undefined;
    let bizFeeBearer: FeeBearer | undefined;
    if (event.business_id) {
      const { data: biz } = await supabaseClient
        .from("businesses")
        .select("paystack_subaccount_code, flw_subaccount_id, paystack_fee_bearer")
        .eq("id", event.business_id)
        .maybeSingle();
      paystackSubaccountCode = biz?.paystack_subaccount_code ?? undefined;
      flwSubaccountId = biz?.flw_subaccount_id ?? undefined;
      bizFeeBearer = (biz?.paystack_fee_bearer as FeeBearer) ?? undefined;
    }

    if (safeCurrency !== "NGN" && !flwSubaccountId) {
      return ApiResponse.error(
        res,
        "This organiser has not set up multi-currency payments yet.",
        422,
      );
    }

    // Convert base NGN ticket total to buyer's chosen currency using live FLW rates
    const convertedTotal = await resolvePaymentAmount(
      totalAmount,
      safeCurrency,
    );
    const {
      discountTotal: discountTotalNGN,
      surchargeTotal: surchargeTotalNGN,
      discounts: appliedDiscounts,
    } = summarizePricingAdjustments(pricing);
    const [convertedSubtotal, convertedDiscount, convertedSurcharge] =
      await Promise.all([
        resolvePaymentAmount(pricing.baseTotal, safeCurrency),
        resolvePaymentAmount(discountTotalNGN, safeCurrency),
        resolvePaymentAmount(surchargeTotalNGN, safeCurrency),
      ]);
    const convertedAppliedDiscounts = await Promise.all(
      appliedDiscounts.map(async (discount) => ({
        rule_id: discount.ruleId,
        mode: discount.mode,
        value: discount.value,
        amount: await resolvePaymentAmount(discount.amount, safeCurrency),
        coupon_code: discount.couponCode,
        message: discount.message,
      })),
    );

    const provider = PaymentProviderFactory.getProvider(safeCurrency);
    const { totalToCharge, platformFee, fee } = provider.calculateFees(
      convertedTotal,
      safeCurrency,
    );

    // For NGN/Paystack: resolve charge amount using business fee-bearer setting.
    // Fall back to per-event fee_payer ("organizer" → subaccount, "attendee" → customer).
    // For Flutterwave: no split-payment concept; always charge totalToCharge.
    const feePayer = event.fee_payer || "attendee";
    const fallbackBearer: FeeBearer = feePayer === "organizer" ? "subaccount" : "customer";
    const feeBearer: FeeBearer = bizFeeBearer ?? fallbackBearer;
    const { totalToCharge: ngNChargeAmount, platformFee: ngNPlatformFee } =
      resolveCustomerCharge(convertedTotal, feeBearer);
    const chargeAmount = safeCurrency === "NGN" ? ngNChargeAmount : totalToCharge;
    const resolvedPlatformFee = safeCurrency === "NGN" ? ngNPlatformFee : platformFee;

    const reference =
      safeCurrency === "NGN"
        ? `EVT-${eventId.slice(0, 8)}-${Date.now()}`
        : `FLW-EVT-${eventId.slice(0, 8)}-${Date.now()}`;

    const metadata = {
      transaction_type: "event_ticket" as const,
      full_name: name,
      phone_number,
      gender,
      email,
      business_id: event.business_id,
      custom_answers: custom_answers || {},
      event_id: eventId,
      currency: safeCurrency,
      payment_provider:
        safeCurrency === "NGN" ? ("paystack" as const) : ("flutterwave" as const),
      flw_subaccount_id: flwSubaccountId,
      selectedTickets,
      tickets,
      custom_fields: [
        {
          display_name: "Buyer Name",
          variable_name: "buyer_name",
          value: name || "",
        },
        {
          display_name: "Buyer Email",
          variable_name: "buyer_email",
          value: email || "",
        },
      ],
      recipients: recipients || [],
      coupon_code: coupon_code || null,
      event_payment_summary: {
        currency: safeCurrency,
        subtotal: convertedSubtotal,
        discount: convertedDiscount,
        surcharge: convertedSurcharge,
        amount: chargeAmount,
        coupon_code: coupon_code || null,
        coupon_applied: isCouponApplied(pricingRules, coupon_code),
        discounts: convertedAppliedDiscounts,
      },
      pricing_adjustment_total: pricing.adjustmentTotal,
      pricing_messages: Array.from(
        new Set(
          pricing.breakdown
            .map((seat) => seat.message)
            .filter((message): message is string => !!message),
        ),
      ),
    };

    // Persist the authoritative per-seat breakdown so issuance stamps the right
    // tier/adjustment regardless of metadata size limits or later segment edits.
    if (pricingRules.length > 0) {
      await savePricingSnapshot({
        db: pricingDb,
        reference,
        eventId,
        currency: safeCurrency,
        pricing,
      });
    }

    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";
    const baseCallback = `${frontendUrl}/orders/${reference}`;
    const callbackUrl = event_redirect_url
      ? `${baseCallback}?redirect_url=${encodeURIComponent(event_redirect_url)}`
      : baseCallback;

    const result = await provider.initializePayment({
      amount: chargeAmount,
      email,
      currency: safeCurrency,
      reference,
      metadata,
      callbackUrl,
      customerName: name,
      // Paystack-specific split fields (ignored by Flutterwave)
      subaccountCode: paystackSubaccountCode,
      bearer: feeBearer,
      transactionCharge: Math.round(resolvedPlatformFee * 100), // kobo
      // Flutterwave-specific split fields (ignored by Paystack)
      flwSubaccountId,
      flwMerchantAmount: deriveFlutterwaveMerchantShare({
        feeBearer,
        baseAmount: convertedTotal,
        totalToCharge,
        platformFee,
        gatewayFee: fee,
      }),
    });

    return ApiResponse.success(res, "Payment initialized", {
      authorization_url: result.authorization_url,
      reference: result.reference,
    });
  } catch (error) {
    console.error("[initiateEventPayment] Error:", error);
    // Only surface client-safe validation messages (4xx statusCode); never leak
    // raw internal errors to the buyer.
    const statusCode =
      typeof (error as { statusCode?: unknown })?.statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return ApiResponse.error(
        res,
        (error as { message?: string }).message || "Invalid request",
        statusCode,
      );
    }
    return ApiResponse.error(
      res,
      "We couldn't start your payment right now. Please try again in a few minutes, or contact the event organiser if the problem continues.",
      500,
    );
  }
};

/**
 * @desc  Preview an order's per-attendee pricing without taking payment, so the
 *        checkout can show the tiered total (and rule messages) before paying.
 * @endpoint POST /api/events/:id/quote
 */
export const quoteEventPricing = async (
  req: SupabaseRequest,
  res: Response,
) => {
  const { id: eventId } = req.params;
  const { email, selectedTickets, recipients, coupon_code } = req.body as {
    email: string;
    selectedTickets: Record<string, number>;
    recipients?: EventRecipient[];
    coupon_code?: string;
  };

  if (!email || !selectedTickets || !Object.keys(selectedTickets).length) {
    return ApiResponse.error(res, "email and selectedTickets are required");
  }

  try {
    const supabaseClient = req.supabase ?? publicSupabase;
    const { data: event, error } = await supabaseClient
      .from("events")
      .select("id, business_id, pricing_rules, event_tickets(*)")
      .eq("id", eventId)
      .single();

    if (error || !event) return ApiResponse.error(res, "Event not found");

    const tickets: any[] = Array.isArray(event.event_tickets)
      ? event.event_tickets
      : [];
    const pricing = await resolveOrderPricing({
      db: supabaseAdmin ?? supabaseClient,
      event,
      tickets,
      buyerEmail: email,
      selectedTickets,
      recipients: (recipients ?? []) as EventRecipient[],
      couponCode: coupon_code,
    });

    if (
      coupon_code &&
      isCouponApplied(activePricingRules(event), coupon_code) &&
      pricing.adjustmentTotal < 0 &&
      Math.abs(pricing.adjustmentTotal) > COUPON_DISCOUNT_MAX_RATIO * pricing.baseTotal
    ) {
      return ApiResponse.badRequest(
        res,
        "This coupon code cannot be applied to this purchase — the discount exceeds the maximum allowed.",
      );
    }

    return ApiResponse.success(res, "Pricing quote", {
      baseTotal: pricing.baseTotal,
      adjustmentTotal: pricing.adjustmentTotal,
      total: pricing.baseTotal + pricing.adjustmentTotal,
      couponApplied: isCouponApplied(activePricingRules(event), coupon_code),
      breakdown: pricing.breakdown,
      messages: Array.from(
        new Set(
          pricing.breakdown
            .map((seat) => seat.message)
            .filter((message): message is string => !!message),
        ),
      ),
    });
  } catch (error: any) {
    console.error("[quoteEventPricing] Error:", error);
    return ApiResponse.error(res, error?.message || "Failed to quote pricing");
  }
};
