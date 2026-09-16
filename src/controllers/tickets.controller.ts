import { Response } from "express";
import { SupabaseRequest } from "../types/http";
import { createPurchaseService } from "../services/purchase.service";

/**
 * @desc Resend ticket confirmation email to attendee
 * @access private
 * @endpoint POST /api/dashboard/events/:id/attendees/:attendeeId/resend-ticket
 */
export const resendTicketEmail = async (req: SupabaseRequest, res: Response) => {
  const supabaseClient = req.supabase!;
  const event_id = req.params.id;
  const attendee_id = req.params.attendeeId; // This is the issued_tickets.id
  const user_id = req.user_id!;

  try {
    // 1. Authorization: Fetch event and check permissions
    const { data: event, error: eventError } = await supabaseClient
      .from("events")
      .select("business_id, owner_id")
      .eq("id", event_id)
      .single();

    if (eventError || !event) {
      return res.status(404).json({ success: false, error: "Event not found" });
    }

    const { PermissionService } = require("../services/permission.service");
    const permissionService = new PermissionService(supabaseClient);
    
    const isOwner = event.owner_id === user_id;
    let hasPermission = false;
    
    if (!isOwner && event.business_id) {
      // Permission to manage attendees/orders
      hasPermission = await permissionService.hasPermission(user_id, event.business_id, "event.attendee.checkin") 
        || await permissionService.hasPermission(user_id, event.business_id, "event.update");
    }

    if (!isOwner && !hasPermission) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // 2. Fetch Attendee (Issued Ticket)
    const { data: ticket, error: ticketError } = await supabaseClient
      .from("issued_tickets")
      .select("id, customer_email, order_id")
      .eq("id", attendee_id)
      .eq("event_id", event_id) // Safety check
      .single();

    if (ticketError || !ticket) {
      return res.status(404).json({ success: false, error: "Attendee/Ticket not found" });
    }

    if (!ticket.customer_email || ticket.customer_email.includes("@noemail")) {
      return res.status(400).json({ success: false, error: "No valid email address for this attendee" });
    }

    // 3. Resend Email
    const purchaseService = createPurchaseService(supabaseClient);
    
    // We pass the ticket.order_id for the receipt link (consistent with existing app)
    await purchaseService.sendReceiptEmail(ticket.customer_email, ticket.order_id); 

    return res.status(200).json({
      success: true,
      message: "Ticket confirmation email resent successfully"
    });

  } catch (error: any) {
    console.error("Error resending ticket email:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to resend ticket email"
    });
  }
};
