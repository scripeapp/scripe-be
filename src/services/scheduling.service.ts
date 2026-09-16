import { randomUUID } from "crypto";
import axios from "axios";
import { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "../config/supabaseAdmin";
import { createCalendarEvent } from "./google-calendar.service";
import { emailService } from "./email.service";
import { PaymentProviderFactory } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { resolvePaymentProvider } from "../utils/payment/fees";
import {
  bookingConfirmedAttendee,
  bookingPendingAttendee,
  bookingNewHostNotification,
} from "../utils/emailsTemplate";

// ============================================================================
// Types
// ============================================================================

export interface EventTypePayload {
  slug: string;
  title: string;
  description?: string;
  duration_minutes: number;
  location_type: "google_meet" | "in_person" | "phone" | "custom";
  location_details?: string;
  color?: string;
  is_active?: boolean;
  requires_confirmation?: boolean;
  availability_profile_id?: string | null;
  min_notice_minutes?: number;
  max_advance_days?: number;
  buffer_before_minutes?: number;
  buffer_after_minutes?: number;
  questions?: any[];
  requires_payment?: boolean;
  payment_amount?: number | null;
  payment_label?: string;
  // Event type wizard (Confirmation and reminders step)
  confirmation_message?: string;
  email_reminder_minutes?: number | null;
  sms_reminder_minutes?: number | null;
  redirect_link?: string;
  // Booking form attendee field visibility: 'required' | 'optional' | 'hidden'
  attendee_name_mode?: string;
  attendee_email_mode?: string;
  attendee_phone_mode?: string;
  // Frontend sends this in the body
  business_id?: string;
}

export interface CreateBookingPayload {
  event_type_id: string;
  attendee_name: string;
  attendee_email: string;
  attendee_notes?: string;
  answers?: Record<string, any>;
  booking_date: string; // YYYY-MM-DD
  start_time: string;   // HH:mm
  timezone: string;
}

// ============================================================================
// Service
// ============================================================================

export class SchedulingService {
  constructor(private supabase: SupabaseClient) {}

  // --------------------------------------------------------------------------
  // Event Types
  // --------------------------------------------------------------------------

  // --------------------------------------------------------------------------
  // Defaults Seeding
  // --------------------------------------------------------------------------

  async seedDefaults(userId: string, businessId: string | undefined) {
    // Check which of the two default slugs already exist for this user
    const { data: existing } = await supabaseAdmin!
      .from("event_types")
      .select("slug")
      .eq("user_id", userId)
      .in("slug", ["15-min-call", "30-min-call"]);

    const existingSlugs = new Set((existing ?? []).map((e: any) => e.slug));

    // Both already exist — nothing to do
    if (existingSlugs.has("15-min-call") && existingSlugs.has("30-min-call")) {
      return { seeded: false };
    }

    // Resolve business_id
    let resolvedBusinessId = businessId ?? null;
    if (!resolvedBusinessId) {
      const { data: biz } = await this.supabase
        .from("businesses")
        .select("id")
        .eq("owner_user_id", userId)
        .limit(1)
        .single();
      resolvedBusinessId = biz?.id ?? null;
    }

    const defaultSchedule = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day) => ({
      day,
      isEnabled: !["Saturday", "Sunday"].includes(day),
      ranges: ["Saturday", "Sunday"].includes(day) ? [] : [{ startTime: "09:00", endTime: "17:00" }],
    }));

    // Create standard availability profile (only if we're creating at least one event type)
    let profileId: string | null = null;

    // Only create the profile if at least one event type needs it
    // (reuse an existing "Standard Hours" profile if one already exists for this business)
    const { data: existingProfile } = await supabaseAdmin!
      .from("availability_profiles")
      .select("id")
      .eq("business_id", resolvedBusinessId ?? "")
      .eq("name", "Standard Hours")
      .limit(1)
      .single();

    if (existingProfile?.id) {
      profileId = existingProfile.id;
    } else {
      const { data: newProfile } = await supabaseAdmin!
        .from("availability_profiles")
        .insert({
          name: "Standard Hours",
          description: "Mon – Fri, 9 AM – 5 PM",
          business_id: resolvedBusinessId,
          timezone: "Africa/Lagos",
          weekly_schedule: defaultSchedule,
          date_rules: { blackoutDates: [], startDate: null, endDate: null },
          capacity: { isEnabled: false, maxPerSlot: 1, maxPerDay: null },
          status: "active",
        })
        .select("id")
        .single();
      profileId = newProfile?.id ?? null;
    }

    // Only insert the event types that don't exist yet
    const allDefaults = [
      {
        title: "15-min Call",
        slug: "15-min-call",
        description: "A quick 15-minute call",
        duration_minutes: 15,
        color: "#6366f1",
      },
      {
        title: "30-min Call",
        slug: "30-min-call",
        description: "A 30-minute call",
        duration_minutes: 30,
        color: "#10b981",
      },
    ];

    const toInsert = allDefaults
      .filter((d) => !existingSlugs.has(d.slug))
      .map((d) => ({
        ...d,
        location_type: "google_meet",
        is_active: true,
        requires_confirmation: false,
        min_notice_minutes: 60,
        max_advance_days: 60,
        buffer_before_minutes: 0,
        buffer_after_minutes: 0,
        questions: [],
        user_id: userId,
        business_id: resolvedBusinessId,
        availability_profile_id: profileId,
      }));

    if (toInsert.length > 0) {
      await supabaseAdmin!.from("event_types").insert(toInsert);
    }

    return { seeded: true, created: toInsert.map((d) => d.slug) };
  }

  async listEventTypes(userId: string, businessId?: string) {
    let query = this.supabase
      .from("event_types")
      .select("*, availability_profiles(name, timezone)")
      .eq("user_id", userId)
      .order("created_at", { ascending: false });

    if (businessId) {
      query = query.eq("business_id", businessId);
    }

    const { data, error } = await query;

    if (error) throw error;
    return data;
  }

  async getEventType(id: string, userId: string) {
    const { data, error } = await this.supabase
      .from("event_types")
      .select("*, availability_profiles(name, timezone, weekly_schedule, date_rules, capacity)")
      .eq("id", id)
      .eq("user_id", userId)
      .single();

    if (error || !data) throw { statusCode: 404, message: "Event type not found" };
    return data;
  }

  async getPublicEventType(businessSlug: string, eventSlug: string) {
    // Resolve business slug → business
    const { data: business, error: bizError } = await supabaseAdmin!
      .from("businesses")
      .select("id, name, slug, owner_user_id, logo_url, cover_image, description")
      .eq("slug", businessSlug)
      .single();

    if (bizError || !business) throw { statusCode: 404, message: "Business not found" };

    // Find the event type for this business (by business_id or owner user_id as fallback)
    let { data, error } = await supabaseAdmin!
      .from("event_types")
      .select("*, availability_profiles(name, timezone, weekly_schedule, date_rules, capacity)")
      .eq("business_id", business.id)
      .eq("slug", eventSlug)
      .eq("is_active", true)
      .single();

    // Fallback: look up by owner's user_id (handles event types created before business_id was set)
    if (error || !data) {
      const fallback = await supabaseAdmin!
        .from("event_types")
        .select("*, availability_profiles(name, timezone, weekly_schedule, date_rules, capacity)")
        .eq("user_id", business.owner_user_id)
        .eq("slug", eventSlug)
        .eq("is_active", true)
        .single();

      data = fallback.data;
      error = fallback.error;
    }

    if (error || !data) throw { statusCode: 404, message: "Event type not found" };

    return {
      event_type: data,
      host: {
        name: business.name,
        slug: business.slug,
        logo_url: business.logo_url,
        cover_image: business.cover_image,
        description: business.description,
      },
    };
  }

  async createEventType(userId: string, businessIdFromMiddleware: string | undefined, payload: EventTypePayload) {
    const slug = payload.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");

    // Resolve business_id: from payload body first, then middleware, then look up user's primary business
    let resolvedBusinessId: string | null =
      payload.business_id ?? businessIdFromMiddleware ?? null;

    if (!resolvedBusinessId) {
      const { data: biz } = await this.supabase
        .from("businesses")
        .select("id")
        .eq("owner_user_id", userId)
        .limit(1)
        .single();
      resolvedBusinessId = biz?.id ?? null;
    }

    const { business_id: _removed, ...rest } = payload;

    const { data, error } = await supabaseAdmin!
      .from("event_types")
      .insert({ ...rest, slug, user_id: userId, business_id: resolvedBusinessId })
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw { statusCode: 409, message: "You already have an event type with this slug" };
      throw error;
    }
    return data;
  }

  async updateEventType(id: string, userId: string, payload: Partial<EventTypePayload>) {
    if (payload.slug) {
      payload.slug = payload.slug.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    }

    const { business_id: _removed, ...rest } = payload;

    const { data, error } = await supabaseAdmin!
      .from("event_types")
      .update(rest)
      .eq("id", id)
      .eq("user_id", userId)
      .select()
      .single();

    if (error) {
      if (error.code === "23505") throw { statusCode: 409, message: "You already have an event type with this slug" };
      throw error;
    }
    if (!data) throw { statusCode: 404, message: "Event type not found" };
    return data;
  }

  async deleteEventType(id: string, userId: string) {
    const { error } = await supabaseAdmin!
      .from("event_types")
      .delete()
      .eq("id", id)
      .eq("user_id", userId);

    if (error) throw error;
  }

  // --------------------------------------------------------------------------
  // Public Slot Generation
  // --------------------------------------------------------------------------

  async getAvailableSlots(businessSlug: string, eventSlug: string, date: string) {
    const { event_type } = await this.getPublicEventType(businessSlug, eventSlug);
    const profile = event_type.availability_profiles;

    if (!profile) {
      return this.generateDefaultSlots(date, event_type.duration_minutes, event_type.buffer_after_minutes ?? 0, event_type.min_notice_minutes ?? 60);
    }

    const timezone = profile.timezone ?? "UTC";
    const dayName = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: timezone })
      .format(new Date(date + "T12:00:00Z"));

    const daySchedule = (profile.weekly_schedule ?? []).find(
      (d: any) => d.day === dayName && d.isEnabled
    );

    if (!daySchedule) return [];

    // Check blackout dates
    const blackouts: string[] = (profile.date_rules?.blackoutDates ?? []).map((b: any) => b.date);
    if (blackouts.includes(date)) return [];

    // Check date range
    const { startDate, endDate } = profile.date_rules ?? {};
    if (startDate && date < startDate) return [];
    if (endDate && date > endDate) return [];

    // Generate slots from ranges
    const slots: { time: string; available: boolean }[] = [];
    const duration = event_type.duration_minutes;
    const bufferAfter = event_type.buffer_after_minutes ?? 0;
    const bufferBefore = event_type.buffer_before_minutes ?? 0;
    const minNoticeMs = (event_type.min_notice_minutes ?? 60) * 60 * 1000;
    const nowMs = Date.now();

    for (const range of daySchedule.ranges) {
      const [startH, startM] = range.startTime.split(":").map(Number);
      const [endH, endM] = range.endTime.split(":").map(Number);

      // The first slot starts at startTime + bufferBefore (so we have padding before)
      let cursor = startH * 60 + startM + bufferBefore;
      const rangeEnd = endH * 60 + endM;

      while (cursor + duration + bufferAfter <= rangeEnd) {
        const hh = String(Math.floor(cursor / 60)).padStart(2, "0");
        const mm = String(cursor % 60).padStart(2, "0");
        const slotTime = `${hh}:${mm}`;

        // Min notice check — convert slot time from profile timezone to UTC
        const slotMs = this.localToUtcMs(date, slotTime, timezone);
        const available = slotMs - nowMs >= minNoticeMs;

        slots.push({ time: slotTime, available });
        cursor += duration + bufferAfter + bufferBefore;
      }
    }

    // Mark slots taken by existing confirmed/pending bookings
    const { data: existingBookings } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("start_time, end_time")
      .eq("event_type_id", event_type.id)
      .eq("booking_date", date)
      .in("status", ["confirmed", "pending"]);

    if (existingBookings?.length) {
      const capacity = profile?.capacity;
      const maxPerSlot = capacity?.isEnabled && capacity?.maxPerSlot ? capacity.maxPerSlot : 1;
      const maxPerDay = capacity?.isEnabled && capacity?.maxPerDay ? capacity.maxPerDay : null;

      // Check max per day — if total bookings already hit the daily cap, mark all slots unavailable
      if (maxPerDay !== null && existingBookings.length >= maxPerDay) {
        for (const slot of slots) slot.available = false;
      } else {
        for (const slot of slots) {
          if (!slot.available) continue;
          const slotStart = this.timeToMinutes(slot.time);
          const slotEnd = slotStart + duration;

          // Count how many bookings overlap this slot
          const overlappingCount = existingBookings.filter((b: any) => {
            // PostgreSQL TIME comes back as "HH:MM:SS" — slice to "HH:MM"
            const bStart = this.timeToMinutes(b.start_time.slice(0, 5));
            const bEnd = this.timeToMinutes(b.end_time.slice(0, 5));
            return slotStart < bEnd && slotEnd > bStart;
          }).length;

          if (overlappingCount >= maxPerSlot) slot.available = false;
        }
      }
    }

    return slots;
  }

  private generateDefaultSlots(date: string, duration: number, bufferAfter: number, minNoticeMinutes: number, timezone = "UTC") {
    const slots: { time: string; available: boolean }[] = [];
    let cursor = 9 * 60; // 9am
    const end = 17 * 60; // 5pm
    const nowMs = Date.now();
    const minNoticeMs = minNoticeMinutes * 60 * 1000;

    while (cursor + duration <= end) {
      const hh = String(Math.floor(cursor / 60)).padStart(2, "0");
      const mm = String(cursor % 60).padStart(2, "0");
      const slotTime = `${hh}:${mm}`;
      const slotMs = this.localToUtcMs(date, slotTime, timezone);
      slots.push({ time: slotTime, available: slotMs - nowMs >= minNoticeMs });
      cursor += duration + bufferAfter;
    }
    return slots;
  }

  private timeToMinutes(time: string): number {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }

  // Convert a local time in the given IANA timezone to UTC milliseconds.
  // Uses the "reflection trick": treat the time as UTC, format it in the target
  // timezone, compute the displayed offset, then subtract it.
  private localToUtcMs(dateStr: string, timeStr: string, timezone: string): number {
    const naiveUtc = new Date(`${dateStr}T${timeStr}:00Z`);
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: false,
    });
    const parts = Object.fromEntries(
      dtf.formatToParts(naiveUtc)
        .filter(p => p.type !== "literal")
        .map(p => [p.type, p.value])
    );
    const h = parts.hour === "24" ? 0 : Number(parts.hour);
    const displayedMs = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      h, Number(parts.minute), Number(parts.second)
    );
    // offset = displayed - naive; result = naive - offset = 2*naive - displayed
    return 2 * naiveUtc.getTime() - displayedMs;
  }

  // --------------------------------------------------------------------------
  // Bookings
  // --------------------------------------------------------------------------

  async createBooking(payload: CreateBookingPayload) {
    if (!payload.event_type_id || !payload.booking_date || !payload.start_time) {
      throw { statusCode: 400, message: "Missing required booking fields" };
    }

    const { data: eventType, error: etError } = await supabaseAdmin!
      .from("event_types")
      .select("id, title, duration_minutes, requires_confirmation, location_type, user_id, requires_payment, payment_amount, payment_label, availability_profiles(capacity)")
      .eq("id", payload.event_type_id)
      .eq("is_active", true)
      .single();

    if (etError || !eventType) throw { statusCode: 404, message: "Event type not found" };
    if (!eventType.user_id) throw { statusCode: 400, message: "Event type has no host" };

    const [startH, startM] = payload.start_time.split(":").map(Number);
    const endMinutes = startH * 60 + startM + eventType.duration_minutes;
    const endTime = `${String(Math.floor(endMinutes / 60)).padStart(2, "0")}:${String(endMinutes % 60).padStart(2, "0")}`;

    // Prevent double-booking race condition — re-validate slot before insert
    const capacity = (eventType as any).availability_profiles?.capacity;
    const maxPerSlot = capacity?.isEnabled && capacity?.maxPerSlot ? capacity.maxPerSlot : 1;
    const { count: conflictCount } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("id", { count: "exact", head: true })
      .eq("event_type_id", payload.event_type_id)
      .eq("booking_date", payload.booking_date)
      .in("status", ["confirmed", "pending", "awaiting_payment"])
      .lt("start_time", endTime)
      .gt("end_time", payload.start_time);

    if (conflictCount !== null && conflictCount >= maxPerSlot) {
      throw { statusCode: 409, message: "This time slot is no longer available. Please choose another." };
    }

    // Payment-required events start as "awaiting_payment"; otherwise normal flow
    const requiresPayment = !!(eventType as any).requires_payment && (eventType as any).payment_amount > 0;
    const status = requiresPayment ? "awaiting_payment" : (eventType.requires_confirmation ? "pending" : "confirmed");

    const { data: booking, error: bookingError } = await supabaseAdmin!
      .from("scheduled_bookings")
      .insert({
        event_type_id: payload.event_type_id,
        host_user_id: eventType.user_id,
        attendee_name: payload.attendee_name,
        attendee_email: payload.attendee_email,
        attendee_notes: payload.attendee_notes ?? null,
        answers: payload.answers ?? {},
        booking_date: payload.booking_date,
        start_time: payload.start_time,
        end_time: endTime,
        timezone: payload.timezone,
        status,
        payment_status: requiresPayment ? "pending" : "unpaid",
        payment_amount: requiresPayment ? (eventType as any).payment_amount : null,
        cancel_token: randomUUID(),
        reschedule_token: randomUUID(),
      })
      .select()
      .single();

    if (bookingError) throw bookingError;

    // If payment is required, initiate Paystack and return authorization_url
    if (requiresPayment) {
      try {
        const et = eventType as any;
        const currency = ((et.payment_currency || "NGN") as SupportedCurrency);
        const provider = PaymentProviderFactory.getProvider(currency);
        const { totalToCharge, platformFee, fee: gatewayFee } = provider.calculateFees(et.payment_amount, currency);

        // Fetch host's business subaccount for split payment
        const { data: bizRow } = await supabaseAdmin!
          .from("businesses")
          .select("paystack_subaccount_code, flw_subaccount_id")
          .eq("owner_user_id", eventType.user_id)
          .limit(1)
          .maybeSingle();

        const subaccountCode = bizRow?.paystack_subaccount_code;
        const flwSubaccountId: string | undefined = bizRow?.flw_subaccount_id ?? undefined;

        if (currency !== "NGN" && !flwSubaccountId) {
          throw Object.assign(
            new Error("This host has not set up multi-currency payments yet."),
            { statusCode: 422 },
          );
        }

        const schedRef =
          currency === "NGN"
            ? `SCHED_${booking.id}_${Date.now()}`
            : `FLW-SCHED_${booking.id}_${Date.now()}`;

        const payResult = await provider.initializePayment({
          amount: totalToCharge,
          email: payload.attendee_email,
          currency,
          reference: schedRef,
          callbackUrl: `${process.env.FRONTEND_URL ?? "http://localhost:3000"}/b/payment-confirm?booking_id=${booking.id}`,
          subaccountCode: subaccountCode ?? undefined,
          bearer: subaccountCode ? "subaccount" : "customer",
          flwSubaccountId,
          flwMerchantAmount: et.payment_amount, // merchant receives base; Hilaq gets the gross-up
          metadata: {
            transaction_type: "scheduling_payment",
            booking_id: booking.id,
            event_type_id: eventType.id,
            attendee_name: payload.attendee_name,
            attendee_email: payload.attendee_email,
            items_total: et.payment_amount,
            platform_fee: platformFee,
            gateway_fee_estimate: gatewayFee,
            paystack_fee_estimate: gatewayFee, // legacy key for in-flight checkouts
            fee_bearer: subaccountCode ? "subaccount" : "customer",
            currency,
            payment_provider: resolvePaymentProvider(currency),
          },
        });

        const reference = payResult.reference;
        const authorization_url = payResult.authorization_url;

        // Store reference on the booking
        await supabaseAdmin!
          .from("scheduled_bookings")
          .update({ payment_reference: reference })
          .eq("id", booking.id);

        return { booking: { ...booking, payment_reference: reference }, event_type: eventType, authorization_url, requires_payment: true };
      } catch (payErr: any) {
        // Delete the pending booking on payment init failure to avoid orphans
        await supabaseAdmin!.from("scheduled_bookings").delete().eq("id", booking.id);
        throw { statusCode: 500, message: "Failed to initiate payment: " + (payErr.message ?? "Unknown error") };
      }
    }

    // Fire-and-forget: attach calendar first so meet link is ready before email
    if (status === "confirmed") {
      this.attachGoogleCalendar(eventType, booking)
        .then(async () => {
          const { data: updatedBooking } = await supabaseAdmin!
            .from("scheduled_bookings")
            .select()
            .eq("id", booking.id)
            .single();
          return this.sendBookingEmails(eventType, updatedBooking ?? booking, status);
        })
        .catch((err) => {
          console.error("[Scheduling] Post-booking calendar/email failed:", err);
          this.sendBookingEmails(eventType, booking, status).catch((e) =>
            console.error("[Scheduling] Fallback email failed:", e)
          );
        });
    } else {
      this.sendBookingEmails(eventType, booking, status).catch((err) =>
        console.error("[Scheduling] Booking emails failed:", err)
      );
    }

    return { booking, event_type: eventType };
  }

  async confirmSchedulingPayment(bookingId: string, reference: string, amountPaid: number): Promise<void> {
    const { data: booking } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("*, event_types(id, title, duration_minutes, location_type, requires_confirmation, user_id)")
      .eq("id", bookingId)
      .maybeSingle();

    if (!booking) throw { statusCode: 404, message: "Booking not found" };

    // Idempotency — already confirmed (e.g. webhook fired twice)
    if (booking.payment_status === "paid") {
      console.log(`[Scheduling] Booking ${bookingId} already confirmed, skipping duplicate webhook`);
      return;
    }

    // Defensive slot conflict check — guard against the rare race where two payments
    // land for the same slot before either webhook fires
    const { count: conflictCount } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("id", { count: "exact", head: true })
      .eq("event_type_id", booking.event_type_id)
      .eq("booking_date", booking.booking_date)
      .in("status", ["confirmed", "pending"])
      .lt("start_time", booking.end_time)
      .gt("end_time", booking.start_time)
      .neq("id", bookingId); // exclude this booking itself

    if (conflictCount && conflictCount > 0) {
      // Slot was taken by someone else — cancel this booking and flag for refund
      await supabaseAdmin!
        .from("scheduled_bookings")
        .update({
          status: "cancelled",
          payment_status: "refunded",
          payment_reference: reference,
          payment_amount: amountPaid / 100,
          paid_at: new Date().toISOString(),
        })
        .eq("id", bookingId);

      console.error(
        `[Scheduling] Slot conflict detected for booking ${bookingId} after payment ${reference}. ` +
        `Marked as cancelled+refunded. Manual refund required.`
      );
      // TODO: trigger automatic Paystack refund here when refund API is wired up
      return;
    }

    const newStatus = booking.event_types?.requires_confirmation ? "pending" : "confirmed";

    await supabaseAdmin!
      .from("scheduled_bookings")
      .update({
        status: newStatus,
        payment_status: "paid",
        payment_reference: reference,
        payment_amount: amountPaid / 100,
        paid_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    if (newStatus === "confirmed") {
      const eventType = booking.event_types;
      const updatedBooking = { ...booking, status: newStatus, payment_status: "paid" };
      this.attachGoogleCalendar(eventType, updatedBooking)
        .then(async () => {
          const { data: fresh } = await supabaseAdmin!.from("scheduled_bookings").select().eq("id", bookingId).single();
          return this.sendBookingEmails(eventType, fresh ?? updatedBooking, newStatus);
        })
        .catch(() => {
          this.sendBookingEmails(eventType, updatedBooking, newStatus).catch(() => {});
        });
    } else {
      this.sendBookingEmails(booking.event_types, booking, newStatus).catch(() => {});
    }
  }

  private async attachGoogleCalendar(eventType: any, booking: any) {
    const { data: integration } = await supabaseAdmin!
      .from("calendar_integrations")
      .select("refresh_token")
      .eq("user_id", eventType.user_id)
      .eq("provider", "google")
      .single();

    if (!integration?.refresh_token) return;

    // Fetch profile timezone so Google Calendar shows the correct local time
    const { data: etData } = await supabaseAdmin!
      .from("event_types")
      .select("availability_profiles(timezone)")
      .eq("id", eventType.id)
      .single();
    const profileTimezone = (etData as any)?.availability_profiles?.timezone ?? "UTC";

    // Supabase returns TIME columns as "HH:MM:SS" — slice to "HH:MM" before building ISO string
    const startTime = booking.start_time.slice(0, 5);
    const endTime = booking.end_time.slice(0, 5);
    const startDateTime = `${booking.booking_date}T${startTime}:00`;
    const endDateTime = `${booking.booking_date}T${endTime}:00`;

    const calEvent = await createCalendarEvent(integration.refresh_token, {
      summary: `${eventType.title} with ${booking.attendee_name}`,
      description: booking.attendee_notes ?? "",
      startTime: startDateTime,
      endTime: endDateTime,
      timezone: profileTimezone,
      attendeeEmails: [booking.attendee_email],
      withMeet: eventType.location_type === "google_meet",
    });

    const meetLink =
      calEvent.conferenceData?.entryPoints?.find(
        (e: any) => e.entryPointType === "video"
      )?.uri ?? null;

    await supabaseAdmin!
      .from("scheduled_bookings")
      .update({
        google_calendar_event_id: calEvent.id,
        google_meet_link: meetLink,
      })
      .eq("id", booking.id);
  }

  private async sendBookingEmails(eventType: any, booking: any, status: string) {
    // Get host email via Supabase auth admin
    const { data: { user: hostUser } } = await supabaseAdmin!.auth.admin.getUserById(eventType.user_id);
    if (!hostUser?.email) return;

    const frontendUrl = process.env.FRONTEND_URL ?? "https://hilaq.com";
    const dashboardUrl = `${frontendUrl}/dashboard`;
    const cancelUrl = booking.cancel_token ? `${frontendUrl}/b/cancel?token=${booking.cancel_token}` : null;

    const formattedDate = new Date(booking.booking_date + "T12:00:00Z").toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric", year: "numeric",
    });
    const [h, m] = booking.start_time.split(":").map(Number);
    const ampm = h >= 12 ? "PM" : "AM";
    const formattedTime = `${h % 12 || 12}:${String(m).padStart(2, "0")} ${ampm}`;

    const locationLabels: Record<string, string> = {
      google_meet: "Google Meet",
      in_person: "In Person",
      phone: "Phone",
      custom: "Custom",
    };
    const locationLabel = locationLabels[eventType.location_type] ?? eventType.location_type;

    // Email to attendee
    const attendeeBody = status === "confirmed"
      ? bookingConfirmedAttendee({
          attendee_name: booking.attendee_name,
          event_title: eventType.title,
          host_name: hostUser.user_metadata?.name ?? hostUser.email,
          booking_date: formattedDate,
          start_time: formattedTime,
          duration_minutes: eventType.duration_minutes,
          location_label: locationLabel,
          meet_link: booking.google_meet_link ?? null,
          timezone: booking.timezone,
          cancel_url: cancelUrl,
        })
      : bookingPendingAttendee({
          attendee_name: booking.attendee_name,
          event_title: eventType.title,
          host_name: hostUser.user_metadata?.name ?? hostUser.email,
          booking_date: formattedDate,
          start_time: formattedTime,
          duration_minutes: eventType.duration_minutes,
          timezone: booking.timezone,
        });

    await emailService.send({
      to: booking.attendee_email,
      subject: status === "confirmed"
        ? `Booking confirmed — ${eventType.title}`
        : `Booking request received — ${eventType.title}`,
      body: attendeeBody,
      type: "platform",
    });

    // Notification to host
    const hostName = hostUser.user_metadata?.name ?? hostUser.email;
    await emailService.send({
      to: hostUser.email,
      subject: status === "confirmed"
        ? `New booking — ${eventType.title}`
        : `New booking request — ${eventType.title}`,
      body: bookingNewHostNotification({
        host_name: hostName,
        attendee_name: booking.attendee_name,
        attendee_email: booking.attendee_email,
        event_title: eventType.title,
        booking_date: formattedDate,
        start_time: formattedTime,
        duration_minutes: eventType.duration_minutes,
        timezone: booking.timezone,
        attendee_notes: booking.attendee_notes,
        status: status as "confirmed" | "pending",
        dashboard_url: dashboardUrl,
      }),
      type: "platform",
    });
  }

  async listBookings(userId: string, filters?: { status?: string; upcoming?: boolean }) {
    // Auto-complete any past confirmed/pending bookings before returning the list
    const todayStr = new Date().toISOString().split("T")[0];
    await supabaseAdmin!
      .from("scheduled_bookings")
      .update({ status: "completed" })
      .eq("host_user_id", userId)
      .in("status", ["confirmed", "pending"])
      .lt("booking_date", todayStr);

    let query = supabaseAdmin!
      .from("scheduled_bookings")
      .select("*, event_types(title, duration_minutes, color, location_type, requires_payment, questions)")
      .eq("host_user_id", userId)
      .order("booking_date", { ascending: true })
      .order("start_time", { ascending: true });

    if (filters?.status) query = query.eq("status", filters.status);
    if (filters?.upcoming) {
      query = query
        .gte("booking_date", new Date().toISOString().split("T")[0])
        .not("status", "in", '("cancelled","completed")');
    }

    const { data, error } = await query;
    if (error) throw error;
    return data;
  }

  async confirmBooking(bookingId: string, userId: string) {
    const { data: booking, error: fetchError } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("*, event_types(id, title, duration_minutes, location_type, user_id)")
      .eq("id", bookingId)
      .eq("host_user_id", userId)
      .eq("status", "pending")
      .single();

    if (fetchError || !booking) throw { statusCode: 404, message: "Pending booking not found" };

    const { data, error } = await supabaseAdmin!
      .from("scheduled_bookings")
      .update({ status: "confirmed" })
      .eq("id", bookingId)
      .select()
      .single();

    if (error) throw error;

    // Attach Google Calendar and send confirmation email — fire and forget
    const eventType = booking.event_types;
    if (eventType) {
      this.attachGoogleCalendar(eventType, data).catch((err) =>
        console.error("[Scheduling] Google Calendar attach on confirm failed:", err)
      );
      this.sendBookingEmails(eventType, data, "confirmed").catch((err) =>
        console.error("[Scheduling] Confirm email failed:", err)
      );
    }

    return data;
  }

  async cancelByToken(cancelToken: string) {
    const { data: booking, error } = await supabaseAdmin!
      .from("scheduled_bookings")
      .select("id, attendee_name, attendee_email, booking_date, start_time, end_time, timezone, event_types(title, duration_minutes)")
      .eq("cancel_token", cancelToken)
      .in("status", ["confirmed", "pending"])
      .single();

    if (error || !booking) throw { statusCode: 404, message: "Booking not found or already cancelled" };

    const { data, error: updateError } = await supabaseAdmin!
      .from("scheduled_bookings")
      .update({ status: "cancelled" })
      .eq("id", booking.id)
      .select()
      .single();

    if (updateError) throw updateError;
    return data;
  }

  async cancelBooking(bookingId: string, userId: string, reason?: string) {
    const { data, error } = await supabaseAdmin!
      .from("scheduled_bookings")
      .update({ status: "cancelled", cancel_reason: reason ?? null })
      .eq("id", bookingId)
      .eq("host_user_id", userId)
      .select()
      .single();

    if (error) throw error;
    if (!data) throw { statusCode: 404, message: "Booking not found" };
    return data;
  }

  async checkInBooking(bookingId: string, userId: string) {
    const { data, error } = await supabaseAdmin!
      .from("scheduled_bookings")
      .update({ status: "completed", check_in_time: new Date().toISOString() })
      .eq("id", bookingId)
      .eq("host_user_id", userId)
      .in("status", ["confirmed", "pending"])
      .select()
      .single();

    if (error) throw error;
    if (!data) throw { statusCode: 404, message: "Booking not found" };
    return data;
  }

  async deleteBooking(bookingId: string, userId: string) {
    const { data, error } = await supabaseAdmin!
      .from("scheduled_bookings")
      .delete()
      .eq("id", bookingId)
      .eq("host_user_id", userId)
      .select("id")
      .single();

    if (error) throw error;
    if (!data) throw { statusCode: 404, message: "Booking not found" };
    return data;
  }
}
