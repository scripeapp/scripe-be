import "dotenv/config";
import { sendEmail, isConfigured } from "../config/plunk";
import { supabase } from "../config/supabase";
// Resend Issued event tickets

const resendIssuedEventTicketsWithFilter = async (
  eventId: string,
  startDate: string,
  endDate: string
) => {
  // Validate plunk configuration once before sending
  if (!isConfigured()) {
    console.log("Plunk not configured; skipping email send.");
  }
  // created_at greater than 2025-12-10 15:47:19+01 and less 2025-12-13 08:59:22+01
  const {
    data: wrongIssuedTickets,
    error: wrongIssuedTicketsError,
    count,
  } = await supabase
    .from("issued_tickets")
    .select("customer_email, id, order_id, customer_name", { count: "exact" })
    .eq("event_id", eventId)
    .gt("created_at", startDate)
    .lt("created_at", endDate);

  if (wrongIssuedTicketsError) {
    console.error("Error fetching issued tickets:", wrongIssuedTicketsError);
    return;
  }
  console.log("Fetched issued tickets count:", count);

  // console.log("Issued tickets data:", wrongIssuedTickets);

  // put in array of {customer_email:string}[]
  const emails_with_issues = [
    { customer_email: "Fiyinayotunde@gmail.com" },
    { customer_email: "Lateefatisiaq23@gmail.com" },
    { customer_email: "Apatirasulayman@gmail.com" },
    { customer_email: "Lawal.kabirbolu@gmail.com" },
    { customer_email: "Aishateejay03@gmail.com" },
    { customer_email: "Farhanahododo@gmail.com" },
    { customer_email: "Maryamboluwatife620@gmail.com" },
    { customer_email: "Yusufogunlola97@gmail.com" },
    { customer_email: "Raqeebatbuhari@gmail.com" },
    { customer_email: "Abdurroheem20@gmail.com" },
    { customer_email: "Fathianurudeen63@gmail.com" },
    { customer_email: "Obilanaamirah63@gmail.com" },
    { customer_email: "Mustapharukayat99@gmail.com" },
    { customer_email: "Abuuaaliyah@yahoo.com" },
    { customer_email: "Abiodunsukurat24@gmail.com" },
    { customer_email: "Kehindesherifat53@gmail.com" },
    { customer_email: "Quadraheem@gmail.com" },
    { customer_email: "Abdulquadrizainob25@gmail.com" },
    { customer_email: "Tundelukman@gmail.com" },
    { customer_email: "Petylexpetty2015@gmail.com" },
    { customer_email: "Tendersproutkids@gmail.com" },
  ];

  // filter and log those users in issuedTicketsData and not in emails_with_issues

  const undeterminedList: {
    customer_email: string;
    id: string;
    order_id: string;
    customer_name: string;
  }[] = [];
  wrongIssuedTickets.map((i) => {
    if (
      emails_with_issues.find(
        (e) => e.customer_email.toLowerCase() === i.customer_email.toLowerCase()
      )
    ) {
      undeterminedList.push(i);
    }
  });

  // Group by customer_email and count quantity, collect order_ids
  const emailMap: Record<
    string,
    {
      customer_email: string;
      ticketId: string;
      orderId: string;
      customer_name: string;
      quantity: number;
      ticketIds: string[];
      useOrderId: boolean;
    }
  > = {};

  undeterminedList.forEach((item) => {
    const email = item.customer_email.toLowerCase();
    if (!emailMap[email]) {
      emailMap[email] = {
        customer_email: item.customer_email,
        customer_name: item.customer_name,
        ticketId: item.id,
        orderId: item.order_id,
        quantity: 1,
        ticketIds: [item.id],
        useOrderId: false,
      };
    } else {
      emailMap[email].quantity += 1;
      emailMap[email].ticketIds.push(item.id);
      emailMap[email].useOrderId = true;
      emailMap[email].orderId = item.order_id;
    }
  });

  // Convert map to array
  const processedList = Object.values(emailMap).map((entry) => ({
    customer_email: entry.customer_email,
    customer_name: entry.customer_name,
    ticketId: entry.ticketId,
    orderId: entry.orderId,
    quantity: entry.quantity,
    ticketIds: entry.ticketIds,
    useOrderId: entry.useOrderId,
  }));

  console.log("Processed issued tickets:", processedList, processedList.length);

  for (const ticket of processedList) {
    // prepare the email receipt template for each ticket
    const eventEmailData: {
      to: string;
      name: string;
      subject: string;
      type: "markdown";
      body: string;
    } = {
      to: ticket.customer_email,
      name: "Hilaq Events",
      subject: "Your Hilaq Event Tickets – Order Confirmation (Updated)",
      type: "markdown",
      body: `Dear ${ticket.customer_name},

   We’re resending your order confirmation to ensure everything is correct. Your order details and tickets are available online. Please click the link below to view and download your ticket:

    👉 [**View Your Ticket**](https://www.hilaq.com/orders/receipt/${
      ticket.useOrderId ? ticket.orderId : ticket.ticketId
    })

    Important Notes:
    - Please arrive at least 30 minutes before the event
    - Have your tickets ready for scanning (digital or printed)
    - Each ticket has a unique QR code for entry

    If you have any questions about your order, please contact our support team at support@hilaq.com.

    We look forward to seeing you at the event!

    Best regards,
    The Hilaq Events Team

    Note: If you are seeing this email, it means we had to resend your ticket. Please use the link above to access your ticket.`,
    };

    // send the email receipt.
    if (!isConfigured()) continue;

    try {
      await sendEmail(eventEmailData);
      // Log sent details
      console.log(
        `Resent ticket email to: ${ticket.customer_email}, Order ID: ${
          ticket.orderId
        }, Ticket IDs: ${ticket.ticketIds.join(", ")}, Quantity: ${
          ticket.quantity
        }`
      );
    } catch (sendErr) {
      console.error(`Send failed for ${ticket.customer_email}:`, sendErr);
    }
  }

  console.log("Done.");
};

// Call the function with the specific event ID
resendIssuedEventTicketsWithFilter(
  "74d98930-1152-46b4-9351-8ea51553ef9b",
  "2025-12-10 15:47:19+01",
  "2025-12-13 08:59:22+01"
);

// Subject: Your Hilaq Event Tickets – Order Confirmation (Updated)

// Hi [First Name],

// We’re resending your order confirmation to ensure everything is correct. Your order details and tickets are available online. Please click the link below to view and download your ticket:

// 👉 [**View Your Ticket**](link)

// Important Notes:
// - Please arrive at least 30 minutes before the event
// - Have your tickets ready for scanning (digital or printed)
// - Each ticket has a unique QR code for entry

// If you have any questions about your order, please contact our support team at support@hilaq.com.

// We look forward to seeing you at the event!

// Best regards,
// The Hilaq Events Team
