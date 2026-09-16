/**
 * Booking Service
 * Handles service booking management for stores
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { generateBookingICS } from "../utils/ics-generator";
import { buildGoogleCalendarUrl } from "../utils/sessionEmails";
import axios from "axios";
import { PaymentProviderFactory } from "../utils/payment";
import type { SupportedCurrency } from "../utils/payment";
import { resolvePaymentProvider } from "../utils/payment/fees";
import { AvailabilityService } from "./availability.service";

import { ServiceBooking } from "../types/store";
import { storeEmailService } from "../utils/storeEmails.util";


export interface CreateBookingPayload {
  order_id: string;
  product_id: string;
  store_id: string;
  customer_id?: string;
  customer_email?: string;
  customer_name?: string;
  booking_date: string;
  start_time: string;
  end_time: string;
  notes?: string;
  location_type?: string;
  location_details?: string;
  approval_required?: boolean;
  duration_minutes?: number;
  status?: ServiceBooking['status'];
  payment_amount?: number;
  payment_reference?: string;
  payment_status?: 'unpaid' | 'pending' | 'paid' | 'refunded';
  paid_at?: string;
}

export interface BookingFilters {
  store_id: string;
  start_date?: string;
  end_date?: string;
  status?: string;
  order_id?: string;
  product_id?: string;
  page?: number;
  limit?: number;
}

export class BookingService {
  constructor(private supabase: SupabaseClient) {}

  /**
   * Create a new service booking (typically called after order completion)
   */
  async createBooking(payload: CreateBookingPayload): Promise<ServiceBooking> {
    const { data, error } = await this.supabase
      .from("service_bookings")
      .insert({
        order_id: payload.order_id,
        product_id: payload.product_id,
        store_id: payload.store_id,
        customer_id: payload.customer_id || null,
        customer_email: payload.customer_email || null,
        customer_name: payload.customer_name || null,
        booking_date: payload.booking_date,
        start_time: payload.start_time,
        end_time: payload.end_time,
        notes: payload.notes || null,
        status: payload.status || "confirmed",
        location_type: payload.location_type || null,
        location_details: payload.location_details || null,
        approval_required: payload.approval_required || false,
        duration_minutes: payload.duration_minutes || null,
        payment_amount: payload.payment_amount ?? null,
        payment_reference: payload.payment_reference ?? null,
        payment_status: payload.payment_status ?? 'unpaid',
        paid_at: payload.paid_at ?? null,
      })
      .select()
      .single();

    if (error) {
      console.error("[BookingService.createBooking] Error:", error);
      throw error;
    }

    return data as ServiceBooking;
  }

  /**
   * Get bookings for a store with optional filters
   */
  async getStoreBookings(
    filters: BookingFilters,
  ): Promise<{ data: ServiceBooking[]; meta: { total: number; page: number; limit: number; totalPages: number } }> {
    const page = filters.page ?? 1;
    const limit = Math.min(filters.limit ?? 50, 50);
    const offset = (page - 1) * limit;

    let query = this.supabase
      .from("service_bookings")
      .select(`
        *,
        product:products(id, name, cover_image),
        order:store_orders(id, total, customer_email)
      `, { count: "exact" })
      .eq("store_id", filters.store_id)
      .order("booking_date", { ascending: true })
      .order("start_time", { ascending: true })
      .range(offset, offset + limit - 1);

    if (filters.start_date) {
      query = query.gte("booking_date", filters.start_date);
    }

    if (filters.end_date) {
      query = query.lte("booking_date", filters.end_date);
    }

    if (filters.status) {
      query = query.eq("status", filters.status);
    }

    if (filters.order_id) {
      query = query.eq("order_id", filters.order_id);
    }

    if (filters.product_id) {
      query = query.eq("product_id", filters.product_id);
    }

    const { data, error, count } = await query;

    if (error) {
      console.error("[BookingService.getStoreBookings] Error:", error);
      throw error;
    }

    const total = count ?? 0;
    return {
      data: data as ServiceBooking[],
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Get a single booking by ID
   */
  async getBooking(bookingId: string, storeId: string): Promise<ServiceBooking> {
    const { data, error } = await this.supabase
      .from("service_bookings")
      .select(`
        *,
        product:products(id, name, cover_image, service),
        order:store_orders(id, total, customer_email, customer_name)
      `)
      .eq("id", bookingId)
      .eq("store_id", storeId)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
      }
      throw error;
    }

    return data as ServiceBooking;
  }

  /**
   * Update booking status
   */
  async updateBookingStatus(
    bookingId: string,
    storeId: string,
    status: ServiceBooking["status"],
    declineReason?: string
  ): Promise<ServiceBooking> {
    const updatePayload: Record<string, any> = {
      status,
      updated_at: new Date().toISOString(),
    };

    // Add decline_reason if status is declined
    if (status === "declined" && declineReason) {
      updatePayload.decline_reason = declineReason;
    }

    const { data, error } = await this.supabase
      .from("service_bookings")
      .update(updatePayload)
      .eq("id", bookingId)
      .eq("store_id", storeId)
      .select()
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
      }
      throw error;
    }

    const booking = data as ServiceBooking;

    // Handle side effects (emails, order updates)
    // 3. Completed -> Update Order Status
    if (status === "completed") {
      // Update parent order to fulfilled if all items are done? 
      // Simplified requirement: "Update parent Order status to fulfilled."
      await this.supabase
        .from("store_orders")
        .update({ 
          status: "fulfilled", 
          fulfilled_at: new Date().toISOString() 
        })
        .eq("id", booking.order_id);
      
      // We should probably check if order needs shipping? Service products usually don't.
    }

    if (status === "confirmed" || status === "declined") {
       const fullBooking = await this.getBooking(booking.id, storeId);
       const storeName = (fullBooking as any).store?.name || "Store";
       
       if (status === "confirmed") {
          await storeEmailService.sendBookingConfirmation(fullBooking, storeName);
       } else if (status === "declined") {
          await storeEmailService.sendBookingDecline(fullBooking, storeName, declineReason);
       }
    }

    return booking;
  }

  /**
   * Reschedule a booking to a new date/time
   */
  async rescheduleBooking(
    bookingId: string,
    storeId: string,
    newDate: string,
    newStartTime: string,
    newEndTime: string,
    initiatedBy: "creator" | "customer" = "creator"
  ): Promise<ServiceBooking> {
    // First verify the booking exists
    const existing = await this.getBooking(bookingId, storeId);

    if (existing.status === "cancelled" || existing.status === "completed" || existing.status === "declined") {
      throw Object.assign(
        new Error(`Cannot reschedule a ${existing.status} booking`),
        { statusCode: 400 }
      );
    }

    // Build original datetime for rescheduled_from
    const rescheduledFrom = `${existing.booking_date}T${existing.start_time}:00`;

    const { data, error } = await this.supabase
      .from("service_bookings")
      .update({
        booking_date: newDate,
        start_time: newStartTime,
        end_time: newEndTime,
        status: "rescheduled",
        rescheduled_from: rescheduledFrom,
        initiated_by: initiatedBy,
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId)
      .eq("store_id", storeId)
      .select()
      .single();

    if (error) {
      throw error;
    }

    return data as ServiceBooking;
  }

  /**
   * Get upcoming bookings for today onwards
   */
  async getUpcomingBookings(storeId: string, limit = 10): Promise<ServiceBooking[]> {
    const today = new Date().toISOString().split("T")[0];

    const { data, error } = await this.supabase
      .from("service_bookings")
      .select(`
        *,
        product:products(id, name, cover_image)
      `)
      .eq("store_id", storeId)
      .gte("booking_date", today)
      .in("status", ["confirmed"])
      .order("booking_date", { ascending: true })
      .order("start_time", { ascending: true })
      .limit(limit);

    if (error) {
      throw error;
    }

    return data as ServiceBooking[];
  }

  /**
   * Generate ICS calendar data for a booking
   */
  async generateBookingCalendar(
    bookingId: string,
    storeId: string
  ): Promise<{ icsContent: string; filename: string }> {
    // Fetch booking with related data
    const { data, error } = await this.supabase
      .from("service_bookings")
      .select(`
        *,
        product:products(id, name, service),
        store:stores(id, name, settings)
      `)
      .eq("id", bookingId)
      .eq("store_id", storeId)
      .single();

    if (error || !data) {
      throw Object.assign(new Error("Booking not found"), { statusCode: 404 });
    }

    const booking = data as any;
    const storeName = booking.store?.name || "Store";
    const productName = booking.product?.name || "Service";
    const location = booking.product?.service?.location || undefined;

    const icsContent = generateBookingICS({
      storeName,
      productName,
      bookingDate: booking.booking_date,
      startTime: booking.start_time,
      endTime: booking.end_time,
      location,
      customerName: booking.customer_name,
      customerEmail: booking.customer_email,
      notes: booking.notes,
    });

    const filename = `booking-${booking.booking_date}-${booking.start_time.replace(":", "")}.ics`;

    return { icsContent, filename };
  }

  /**
   * Send reminder email for a booking
   */
  async sendReminder(bookingId: string, storeId: string): Promise<{ sent: boolean }> {
    // Get booking with related data
    const booking = await this.getBooking(bookingId, storeId);

    if (booking.status !== "confirmed" && booking.status !== "pending") {
      throw Object.assign(
        new Error(`Cannot send reminder for a ${booking.status} booking`),
        { statusCode: 400 }
      );
    }

    // TODO: Integrate with email service to send actual reminder
    // For now, log and return success
    console.log(`[BookingService.sendReminder] Reminder sent for booking ${bookingId} to ${booking.customer_email}`);

    return { sent: true };
  }

  /**
   * Get bookings for a customer (by email)
   */
  async getCustomerBookings(customerEmail: string): Promise<ServiceBooking[]> {
    const { data, error } = await this.supabase
      .from("service_bookings")
      .select(`
        *,
        product:products(id, name, cover_image, service),
        store:stores(id, name, slug)
      `)
      .eq("customer_email", customerEmail)
      .order("booking_date", { ascending: false })
      .order("start_time", { ascending: false });

    if (error) {
      console.error("[BookingService.getCustomerBookings] Error:", error);
      throw error;
    }

    return data as ServiceBooking[];
  }

  /**
   * Reserve a slot by creating a pending booking with a 15-minute hold.
   * Used by the checkout page to hold the slot while the customer completes payment details.
   * The reservation is confirmed when the standard checkout webhook fires.
   */
  async reserveBookingSlot(data: {
    product_id: string;
    store_id: string;
    slot: { date: string; startTime: string; endTime: string };
  }): Promise<{ booking_id: string; expires_at: string }> {
    const availabilityService = new AvailabilityService(this.supabase);
    const slotStatus = await availabilityService.validateSlotAvailability(
      data.product_id,
      data.slot,
    );
    if (!slotStatus.isAvailable) {
      throw Object.assign(
        new Error(`Selected slot is unavailable: ${slotStatus.reason}`),
        { statusCode: 409 },
      );
    }

    const { data: booking, error } = await this.supabase
      .from("service_bookings")
      .insert({
        product_id: data.product_id,
        store_id: data.store_id,
        booking_date: data.slot.date,
        start_time: data.slot.startTime,
        end_time: data.slot.endTime,
        status: "pending",
        payment_status: "pending",
        order_id: null,
      })
      .select("id")
      .single();

    if (error || !booking) throw error ?? new Error("Failed to reserve slot");

    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return { booking_id: booking.id, expires_at: expiresAt };
  }

  /**
   * Confirm a pre-reserved pending booking after payment via the standard checkout flow.
   * Called by StoreService.createOrder when metadata.booking_id is present.
   */
  async confirmReservedBooking(
    bookingId: string,
    orderId: string,
    paymentReference: string,
    customerName: string,
    customerEmail: string,
    amountPaidKobo: number,
  ): Promise<void> {
    const { data: booking, error } = await this.supabase
      .from("service_bookings")
      .select("id, approval_required, store_id")
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      throw new Error(`Reserved booking ${bookingId} not found`);
    }

    const confirmedStatus = booking.approval_required ? "pending" : "confirmed";

    const { error: updateError } = await this.supabase
      .from("service_bookings")
      .update({
        order_id: orderId,
        customer_name: customerName,
        customer_email: customerEmail,
        status: confirmedStatus,
        payment_status: "paid",
        payment_reference: paymentReference,
        payment_amount: amountPaidKobo / 100,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    if (updateError) throw updateError;

    this.sendPostPaymentEmail(bookingId, confirmedStatus).catch((err) =>
      console.error("[BookingService.confirmReservedBooking] Email error:", err),
    );
  }

  /**
   * Initiate payment for a standalone booking (not via store cart).
   * Validates slot availability, creates a pending booking, and initialises Paystack.
   * The webhook confirms the booking once payment succeeds.
   */
  async initiateBookingPayment(data: {
    product_id: string;
    store_id: string;
    slot: { date: string; startTime: string; endTime: string };
    customer: { name: string; email: string; phone?: string };
    notes?: string;
    callback_url?: string;
  }): Promise<{
    authorization_url: string;
    reference: string;
    booking_id: string;
    amount: number;
  }> {
    // 1. Validate slot availability
    const availabilityService = new AvailabilityService(this.supabase);
    const slotStatus = await availabilityService.validateSlotAvailability(
      data.product_id,
      data.slot,
    );
    if (!slotStatus.isAvailable) {
      throw Object.assign(
        new Error(`Selected slot is unavailable: ${slotStatus.reason}`),
        { statusCode: 400 },
      );
    }

    // 2. Fetch product price + store Paystack subaccount
    const { data: product, error: productError } = await this.supabase
      .from("products")
      .select("id, name, price, type, service, store_id")
      .eq("id", data.product_id)
      .single();

    if (productError || !product) {
      throw Object.assign(new Error("Product not found"), { statusCode: 404 });
    }
    if (product.type !== "service") {
      throw Object.assign(new Error("Product is not a service"), { statusCode: 400 });
    }

    const { data: store, error: storeError } = await this.supabase
      .from("stores")
      .select("id, name, business_id, paystack_subaccount_code, business:businesses(flw_subaccount_id)")
      .eq("id", data.store_id)
      .single();

    if (storeError || !store) {
      throw Object.assign(new Error("Store not found"), { statusCode: 404 });
    }

    const baseAmount = Number(product.price) || 0;
    const approvalRequired = product.service?.approval_required || false;

    // 3. Create a pending booking now (slot is reserved while customer pays)
    const { data: booking, error: bookingError } = await this.supabase
      .from("service_bookings")
      .insert({
        order_id: null,
        product_id: data.product_id,
        store_id: data.store_id,
        customer_email: data.customer.email,
        customer_name: data.customer.name,
        booking_date: data.slot.date,
        start_time: data.slot.startTime,
        end_time: data.slot.endTime,
        notes: data.notes || null,
        status: "pending",
        approval_required: approvalRequired,
        payment_amount: baseAmount,
        payment_status: baseAmount > 0 ? "pending" : "unpaid",
      })
      .select("id")
      .single();

    if (bookingError || !booking) throw bookingError || new Error("Failed to create pending booking");

    // 4. If free service, confirm immediately without Paystack
    if (baseAmount === 0) {
      const { error: freeUpdateError } = await this.supabase
        .from("service_bookings")
        .update({ status: approvalRequired ? "pending" : "confirmed", payment_status: "unpaid" })
        .eq("id", booking.id);

      if (freeUpdateError) {
        throw freeUpdateError;
      }

      return {
        authorization_url: "",
        reference: "",
        booking_id: booking.id,
        amount: 0,
      };
    }

    // 5. Initiate payment (Paystack for NGN, Flutterwave for other currencies)
    const subaccountCode = store.paystack_subaccount_code || null;
    const flwSubaccountId: string | undefined =
      ((store as any).business as any)?.flw_subaccount_id ?? undefined;

    const currency = (((product as any).payment_currency || (store as any).payment_currency || "NGN") as SupportedCurrency);

    if (currency !== "NGN" && !flwSubaccountId) {
      throw Object.assign(
        new Error("This store has not set up multi-currency payments yet."),
        { statusCode: 422 },
      );
    }

    if (currency === "NGN" && !subaccountCode) {
      throw Object.assign(
        new Error("Payment is not configured for this store. Please contact the organiser."),
        { statusCode: 422 },
      );
    }

    const provider = PaymentProviderFactory.getProvider(currency);
    const { totalToCharge, platformFee } = provider.calculateFees(baseAmount, currency);

    const frontendUrl = process.env.FRONTEND_URL || "https://hilaq.com";
    const baseCallbackUrl = data.callback_url || `${frontendUrl}/order-success`;
    const separator = baseCallbackUrl.includes("?") ? "&" : "?";
    const bookingCallbackUrl = `${baseCallbackUrl}${separator}source=booking&booking_id=${booking.id}`;

    const result = await provider.initializePayment({
      amount: totalToCharge,
      email: data.customer.email,
      currency,
      callbackUrl: bookingCallbackUrl,
      subaccountCode: subaccountCode ?? undefined,
      bearer: "subaccount",
      transactionCharge: Math.round(platformFee * 100),
      flwSubaccountId,
      flwMerchantAmount: baseAmount, // merchant receives base; Hilaq gets the gross-up
      metadata: {
        transaction_type: "booking_payment",
        booking_id: booking.id,
        product_id: data.product_id,
        product_name: product.name,
        store_id: data.store_id,
        store_name: store.name,
        full_name: data.customer.name,
        email: data.customer.email,
        platform_fee: platformFee,
        slot: data.slot,
        currency,
        payment_provider: resolvePaymentProvider(currency),
      },
    });

    // Store the reference on the pending booking for webhook lookup
    const { error: refError } = await this.supabase
      .from("service_bookings")
      .update({ payment_reference: result.reference })
      .eq("id", booking.id);

    if (refError) {
      throw refError;
    }

    return {
      authorization_url: result.authorization_url,
      reference: result.reference,
      booking_id: booking.id,
      amount: totalToCharge,
    };
  }

  /**
   * Confirm a pending booking after Paystack payment succeeds.
   * Called by the webhook handler.
   */
  async confirmBookingPayment(
    bookingId: string,
    reference: string,
    amountPaid: number,
  ): Promise<void> {
    const { data: booking, error } = await this.supabase
      .from("service_bookings")
      .select("id, approval_required, store_id")
      .eq("id", bookingId)
      .single();

    if (error || !booking) {
      throw new Error(`Booking ${bookingId} not found for payment confirmation`);
    }

    const confirmedStatus = booking.approval_required ? "pending" : "confirmed";

    const { error: confirmError } = await this.supabase
      .from("service_bookings")
      .update({
        status: confirmedStatus,
        payment_status: "paid",
        payment_reference: reference,
        payment_amount: amountPaid / 100,
        paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", bookingId);

    if (confirmError) {
      throw confirmError;
    }

    this.sendPostPaymentEmail(bookingId, confirmedStatus).catch((err) =>
      console.error("[BookingService.confirmBookingPayment] Email error:", err),
    );
  }

  private async sendPostPaymentEmail(bookingId: string, status: string): Promise<void> {
    const { data: fullBooking } = await this.supabase
      .from("service_bookings")
      .select("*, product:products(name), store:stores(name, business_id)")
      .eq("id", bookingId)
      .single();

    if (!fullBooking?.customer_email) return;

    const storeName = (fullBooking as any).store?.name || "Store";
    const businessId = (fullBooking as any).store?.business_id;

    if (status === "confirmed") {
      const calendarLinks = this.buildBookingCalendarLinks(fullBooking, storeName);
      await storeEmailService.sendBookingConfirmation(fullBooking, storeName, businessId, calendarLinks);
    } else {
      await storeEmailService.sendBookingRequestReceived(fullBooking, storeName, businessId);
    }
  }

  private buildBookingCalendarLinks(
    booking: { id: string; booking_date: string; start_time: string; end_time: string; location_details?: string | null },
    storeName: string,
  ): { googleCalendarUrl: string; icsUrl: string } {
    const productName = (booking as any).product?.name || "Service";
    const startIso = `${booking.booking_date}T${booking.start_time}:00`;
    const endIso = `${booking.booking_date}T${booking.end_time}:00`;

    const googleCalendarUrl = buildGoogleCalendarUrl({
      title: `${productName} at ${storeName}`,
      start: startIso,
      end: endIso,
      location: booking.location_details || null,
      details: `Service: ${productName}\nStore: ${storeName}`,
    });

    const serverUrl = process.env.SERVER_URL || "https://api.hilaq.com";
    const icsUrl = `${serverUrl}/store/public/booking/${booking.id}/calendar`;

    return { googleCalendarUrl, icsUrl };
  }
}

