/**
 * ICS Calendar File Generator
 * Generates .ics files for calendar event attachments in booking confirmation emails
 */

export interface ICSEventData {
  title: string;
  description?: string;
  location?: string;
  startDate: Date;
  endDate: Date;
  organizerName?: string;
  organizerEmail?: string;
  attendeeName?: string;
  attendeeEmail?: string;
}

/**
 * Generate an ICS calendar event string
 */
export function generateICSEvent(event: ICSEventData): string {
  const formatDate = (date: Date): string => {
    return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  };

  const escapeText = (text: string): string => {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\n/g, "\\n");
  };

  const uid = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}@hilaq.com`;
  const now = formatDate(new Date());

  let icsContent = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Hilaq//Service Booking//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART:${formatDate(event.startDate)}`,
    `DTEND:${formatDate(event.endDate)}`,
    `SUMMARY:${escapeText(event.title)}`,
  ];

  if (event.description) {
    icsContent.push(`DESCRIPTION:${escapeText(event.description)}`);
  }

  if (event.location) {
    icsContent.push(`LOCATION:${escapeText(event.location)}`);
  }

  if (event.organizerEmail) {
    const orgName = event.organizerName || "Hilaq";
    icsContent.push(`ORGANIZER;CN=${escapeText(orgName)}:mailto:${event.organizerEmail}`);
  }

  if (event.attendeeEmail) {
    const attName = event.attendeeName || "Customer";
    icsContent.push(
      `ATTENDEE;CN=${escapeText(attName)};RSVP=TRUE;PARTSTAT=ACCEPTED:mailto:${event.attendeeEmail}`
    );
  }

  icsContent.push(
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "END:VEVENT",
    "END:VCALENDAR"
  );

  return icsContent.join("\r\n");
}

/**
 * Create booking event data from a service booking
 */
export function createBookingEventData(booking: {
  storeName: string;
  productName: string;
  bookingDate: string; // YYYY-MM-DD
  startTime: string;   // HH:mm
  endTime: string;     // HH:mm
  location?: string;
  customerName?: string;
  customerEmail?: string;
  storeEmail?: string;
  notes?: string;
  timezone?: string;
}): ICSEventData {
  const { bookingDate, startTime, endTime, timezone = "Africa/Lagos" } = booking;

  // Parse date and times
  const [year, month, day] = bookingDate.split("-").map(Number);
  const [startH, startM] = startTime.split(":").map(Number);
  const [endH, endM] = endTime.split(":").map(Number);

  // Create Date objects (Note: In production, use a timezone library like date-fns-tz)
  const startDate = new Date(year, month - 1, day, startH, startM, 0);
  const endDate = new Date(year, month - 1, day, endH, endM, 0);

  const description = [
    `Service: ${booking.productName}`,
    `Store: ${booking.storeName}`,
    booking.notes ? `Notes: ${booking.notes}` : "",
    "",
    "Booked via Hilaq",
  ]
    .filter(Boolean)
    .join("\\n");

  return {
    title: `${booking.productName} at ${booking.storeName}`,
    description,
    location: booking.location,
    startDate,
    endDate,
    organizerName: booking.storeName,
    organizerEmail: booking.storeEmail || "bookings@hilaq.com",
    attendeeName: booking.customerName,
    attendeeEmail: booking.customerEmail,
  };
}

/**
 * Generate ICS file content for a service booking
 */
export function generateBookingICS(booking: {
  storeName: string;
  productName: string;
  bookingDate: string;
  startTime: string;
  endTime: string;
  location?: string;
  customerName?: string;
  customerEmail?: string;
  storeEmail?: string;
  notes?: string;
  timezone?: string;
}): string {
  const eventData = createBookingEventData(booking);
  return generateICSEvent(eventData);
}

/**
 * Generate ICS file content for a public event (ticket purchase)
 */
export function generateEventTicketICS(event: {
  eventName: string;
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endDate?: string;  // YYYY-MM-DD — falls back to startDate
  endTime?: string;  // HH:mm — falls back to 2 hours after start
  venue?: string;
  attendeeName?: string;
  attendeeEmail?: string;
  organizerEmail?: string;
}): string {
  const [startYear, startMonth, startDay] = event.startDate.split("-").map(Number);
  const [startH, startM] = event.startTime.split(":").map(Number);

  const endDateStr = event.endDate || event.startDate;
  const [endYear, endMonth, endDay] = endDateStr.split("-").map(Number);

  let endH = startH + 2;
  let endM = startM;
  if (event.endTime) {
    [endH, endM] = event.endTime.split(":").map(Number);
  }

  const startDate = new Date(startYear, startMonth - 1, startDay, startH, startM, 0);
  const endDate = new Date(endYear, endMonth - 1, endDay, endH, endM, 0);

  return generateICSEvent({
    title: event.eventName,
    location: event.venue,
    startDate,
    endDate,
    organizerEmail: event.organizerEmail || "events@hilaq.com",
    attendeeName: event.attendeeName,
    attendeeEmail: event.attendeeEmail,
  });
}
