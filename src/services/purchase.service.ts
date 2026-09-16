import crypto from "node:crypto";
import { SupabaseClient } from "@supabase/supabase-js";
import { generateQRCode } from "../utils/tickets";
import { createTransactionReference, REFERENCE_TYPES } from "../utils/references";
import { Event, EventTicket, Order, TicketSale } from "../types/models";
import { sendEmail, isConfigured } from "../config/plunk";

import { eventTicketReceiptCustomer } from "../utils/emailsTemplate";
import { formatEventDate, isEventDateTbd, EVENT_DATE_TBD_LABEL } from "../utils";

/**
 * Purchase Service
 * Class-based service for ticket purchase operations
 * Extracted from webhook.controller.ts logic for reuse
 */
class PurchaseService {
  constructor(private supabase: SupabaseClient) {}

  // ============================================================================
  // Helper functions
  // ============================================================================

  private splitFullName(fullName?: string) {
    if (!fullName) return { firstname: "", lastname: "" };
    const parts = fullName.trim().split(/\s+/);
    return {
      firstname: parts[0] || "",
      lastname: parts.slice(1).join(" ") || "",
    };
  }

  generateTicketEntryCode(): string {
    const prefix = "TKT-";
    const randomPart = crypto.randomBytes(5).toString("hex").toUpperCase();
    return `${prefix}${randomPart}`;
  }

  generateCashPaymentReference(): string {
    return createTransactionReference(REFERENCE_TYPES.PAYMENT);
  }

  // ============================================================================
  // Customer Management
  // ============================================================================

  async saveCustomer(customerInfo: {
    full_name: string;
    email: string;
    phone_number?: string;
    gender?: string;
  }): Promise<{ id: string }> {
    const { firstname, lastname } = this.splitFullName(customerInfo.full_name);
    const { data, error } = await this.supabase
      .from("customers")
      .upsert(
        {
          firstname,
          lastname,
          email: customerInfo.email,
          phone_number: customerInfo.phone_number || "",
          gender: customerInfo.gender || "",
        },
        { onConflict: "email" },
      )
      .select("id")
      .single();
    if (error) throw error;
    return data;
  }

  // ============================================================================
  // Order Management
  // ============================================================================

  async createOrder(
    customer_id: string,
    event_id: string,
    amount: number,
    payment_reference: string,
    accounting?: {
      currency: string;
      subtotal: number;
      discount: number;
      surcharge: number;
      discountCode?: string | null;
      discounts?: Array<{
        rule_id: string;
        mode: "flat" | "percent";
        value: number;
        amount: number;
        coupon_code?: string;
        message?: string;
      }>;
    },
  ): Promise<Order | null> {
    // Find user_id from email if available
    let userId;
    const { data: customer } = await this.supabase
      .from("customers")
      .select("email")
      .eq("id", customer_id)
      .single();

    if (customer?.email) {
      const { data: user } = await this.supabase
        .from("users")
        .select("id")
        .eq("email", customer.email)
        .single();
      if (user) userId = user.id;
    }

    // ignoreDuplicates: true → INSERT ... ON CONFLICT DO NOTHING.
    // PostgREST returns null (not an error) when the row already exists,
    // making this atomically idempotent: concurrent webhook retries and
    // admin replays can only proceed if they are the one that created the row.
    const { data, error } = await this.supabase
      .from("orders")
      .upsert(
        {
          customer_id,
          user_id: userId,
          event_id,
          // Provider amounts are normalized to minor units; currency records
          // whether those units are pesewas, kobo, cents, etc.
          total_amount: amount / 100,
          // NULL (not the fee-inclusive total) when no pricing evidence
          // exists — a wrong number here poisons discount reporting.
          subtotal_amount: accounting?.subtotal ?? null,
          discount_amount: accounting?.discount ?? 0,
          surcharge_amount: accounting?.surcharge ?? 0,
          currency: accounting?.currency ?? "NGN",
          discount_code:
            accounting?.discount && accounting.discount > 0
              ? accounting.discountCode ?? null
              : null,
          discount_details:
            accounting?.discount && accounting.discount > 0
              ? accounting.discounts ?? []
              : [],
          payment_reference,
        },
        { onConflict: "payment_reference", ignoreDuplicates: true },
      )
      .select("*")
      .maybeSingle();
    if (error) throw error;
    // null means the reference already existed — caller must skip further processing.
    return data as Order | null;
  }

  // ============================================================================
  // Ticket Sales
  // ============================================================================

  async processTicketSales(
    order_id: string,
    selectedTickets: Record<string, number>,
    tickets: Array<EventTicket>,
  ): Promise<TicketSale[]> {
    const ticketSales = Object.keys(selectedTickets).map((ticketId) => ({
      order_id,
      ticket_id: ticketId,
      quantity_sold: selectedTickets[ticketId],
      sale_date: new Date().toISOString(),
    }));

    const { error, data } = await this.supabase
      .from("ticket_sales")
      .insert(ticketSales)
      .select("*, ticket:ticket_id(*), order:order_id(*)");
    if (error) throw error;
    return data;
  }

  async updateTicketQuantities(
    selectedTickets: Record<string, number>,
  ): Promise<void> {
    for (const [ticketId, quantity] of Object.entries(selectedTickets)) {
      const { error } = await this.supabase.rpc("increment_ticket_sold_quantity", {
        p_ticket_id: ticketId,
        p_quantity: quantity,
      });
      if (error) throw error;
    }
  }

  // ============================================================================
  // Event Details
  // ============================================================================

  async getEventDetails(event_id: string): Promise<Event> {
    const { data, error } = await this.supabase
      .from("events")
      .select("*")
      .eq("id", event_id)
      .single();
    if (error) throw error;
    return data;
  }

  async getEventTicket(ticket_id: string): Promise<EventTicket> {
    const { data, error } = await this.supabase
      .from("event_tickets")
      .select("*")
      .eq("id", ticket_id)
      .single();
    if (error) throw error;
    return data;
  }

  // ============================================================================
  // Ticket Generation
  // ============================================================================

  async generateAndStoreTickets(
    ticketSalesResp: TicketSale[],
    eventData: Event,
    orderData: Order,
    purchaserData: {
      full_name: string;
      email: string;
      phone_number?: string;
      gender?: string;
    },
    event_id: string,
    options: {
      checkInImmediately?: boolean;
      paymentMethod?: "online" | "cash";
    } = {},
  ): Promise<any[]> {
    const now = new Date();
    const eventDateString = isEventDateTbd(eventData.start_date)
      ? EVENT_DATE_TBD_LABEL
      : `${eventData.start_date} from ${eventData.start_time} to ${eventData.end_time}`;

    const baseTicketInfo = (purchase: any, customerName: string) => ({
      eventName: eventData.event_name,
      ticketName: `${purchase.ticket.ticket_name} - ₦${Number(
        purchase.ticket.ticket_price,
      ).toLocaleString()}`,
      ticketPrice: purchase.ticket.ticket_price,
      address: eventData.is_physical
        ? (eventData.venue?.placeDesc ?? "Unknown venue")
        : "Online Event",
      eventDate: eventDateString,
      orderId: orderData.id,
      customerName,
      orderDate: now.toDateString(),
      time: now.toLocaleTimeString(),
      date: now.toDateString(),
    });

    const storeTickets = async (tickets: any[]) => {
      const payload = tickets.map((t) => ({
        order_id: t.orderId,
        customer_name: t.customerName,
        customer_phone: t.customer_phone,
        customer_gender: t.customer_gender,
        ticket_name: t.ticketName,
        ticket_price: t.ticketPrice,
        entry_code: t.ticketEntryCode,
        qr_code: t.qrCode,
        event_id,
        customer_email: t.customer_email,
        checked_in: options.checkInImmediately || false,
        check_in_time: options.checkInImmediately ? now.toISOString() : null,
        payment_method: options.paymentMethod || "online",
      }));
      const { data: inserted, error } = await this.supabase
        .from("issued_tickets")
        .insert(payload)
        .select("id");
      if (error) throw error;
      // Assign registration numbers sequentially
      if (inserted) {
        for (const row of inserted) {
          await this.supabase.rpc("assign_registration_number", {
            p_ticket_id: row.id,
            p_event_id: event_id,
          });
        }
      }
    };

    // Generate tickets for purchaser
    const purchaserTickets = await Promise.all(
      ticketSalesResp.map(async (purchase) => {
        const tickets: any[] = [];
        for (let i = 0; i < purchase.quantity_sold; i++) {
          const entry_code = this.generateTicketEntryCode();
          const qrCode = await generateQRCode(entry_code);
          tickets.push({
            ...baseTicketInfo(purchase, purchaserData.full_name),
            ticketEntryCode: entry_code,
            qrCode,
            customer_email: purchaserData.email,
            customer_phone: purchaserData.phone_number,
            customer_gender: purchaserData.gender,
          });
        }
        return tickets;
      }),
    );

    const flat = purchaserTickets.flat();
    await storeTickets(flat);
    return flat;
  }

  // ============================================================================
  // Email Receipts
  // ============================================================================

  async sendReceiptEmail(
    userEmail: string,
    ticketId: string,
    eventContext?: {
      eventName?: string;
      eventDate?: string;
      venue?: string;
      confirmationEmail?: { subject?: string; message?: string } | null;
      dateTbd?: boolean;
    },
  ): Promise<void> {
    console.log("Sending email receipt:", userEmail, ticketId);

    if (!isConfigured()) {
      console.warn("Plunk not configured. Skipping receipt email.");
      return;
    }

    const eventName = eventContext?.eventName ?? "your event";
    const eventDate = eventContext?.eventDate ?? "";
    const venue = eventContext?.venue ?? "";
    const dateTbd = eventContext?.dateTbd ?? false;

    await sendEmail({
      to: userEmail,
      name: "Hilaq Events",
      subject: `Your ticket for ${eventName}`,
      type: "html",
      body: eventTicketReceiptCustomer({ ticketId, eventName, eventDate, venue, dateTbd }),
    });
  }

  // ============================================================================
  // Cash Purchase Flow
  // ============================================================================

  async processCashPurchase(params: {
    event_id: string;
    customer_name: string;
    customer_email?: string;
    customer_phone?: string;
    customer_gender?: string;
    ticket_id: string;
    quantity: number;
    check_in_immediately?: boolean;
  }): Promise<{
    order_id: string;
    tickets_issued: number;
    checked_in: boolean;
    payment_reference: string;
  }> {
    const {
      event_id,
      customer_name,
      customer_email,
      customer_phone,
      customer_gender,
      ticket_id,
      quantity,
      check_in_immediately,
    } = params;

    // Generate email if not provided
    const email = customer_email || `cash-${Date.now()}@noemail.local`;

    // Get ticket details
    const ticket = await this.getEventTicket(ticket_id);
    if (!ticket) {
      throw new Error("Ticket type not found");
    }

    // Get event details
    const eventData = await this.getEventDetails(event_id);

    // Calculate amount (in kobo for consistency with existing logic)
    const amount = ticket.ticket_price * quantity * 100;

    // Generate cash payment reference
    const payment_reference = this.generateCashPaymentReference();

    // Create customer
    const customerData = await this.saveCustomer({
      full_name: customer_name,
      email,
      phone_number: customer_phone,
      gender: customer_gender,
    });

    // Create order (cash references are unique per call, so null is impossible here)
    const orderData = await this.createOrder(
      customerData.id,
      event_id,
      amount,
      payment_reference,
    );
    if (!orderData) throw new Error(`Failed to create order for reference ${payment_reference}`);

    const tickets = [ticket];
    const selectedTickets: Record<string, number> = { [ticket.id]: quantity };

    // Process ticket sales
    const ticketSalesResp = await this.processTicketSales(
      orderData.id,
      selectedTickets,
      tickets,
    );

    // Update ticket quantities
    await this.updateTicketQuantities(selectedTickets);

    // Generate and store issued tickets
    const issuedTickets = await this.generateAndStoreTickets(
      ticketSalesResp,
      eventData,
      orderData,
      {
        full_name: customer_name,
        email,
        phone_number: customer_phone,
        gender: customer_gender,
      },
      event_id,
      { checkInImmediately: check_in_immediately, paymentMethod: "cash" },
    );

    // Send receipt email (only if real email provided)
    if (customer_email && !customer_email.endsWith("@noemail.local")) {
      try {
        const venue = (eventData as any).is_physical
          ? ((eventData as any).venue?.placeDesc ?? (eventData as any).venue?.full_address ?? "Venue TBA")
          : "Online Event";
        await this.sendReceiptEmail(email, orderData.id, {
          eventName: (eventData as any).event_name,
          eventDate: formatEventDate(
            (eventData as any).start_date,
            (eventData as any).start_time,
          ),
          venue,
          confirmationEmail: (eventData as any).confirmation_email ?? null,
          dateTbd: isEventDateTbd((eventData as any).start_date),
        });
      } catch (emailError) {
        console.error("Failed to send receipt email:", emailError);
        // Don't fail the whole purchase if email fails
      }
    }

    return {
      order_id: orderData.id,
      tickets_issued: issuedTickets.length,
      checked_in: check_in_immediately || false,
      payment_reference,
    };
  }
}

// Factory function to create service instance
export const createPurchaseService = (supabase: SupabaseClient) =>
  new PurchaseService(supabase);

export default PurchaseService;
