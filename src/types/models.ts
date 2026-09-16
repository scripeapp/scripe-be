export interface User {
  id: string;
  name: string;
  email: string;
  created_at: string;
  updated_at: string;
}

export interface PublicationUser {
  name: string;
  email: string;
}

export interface Publication {
  id: string;
  name: string;
  description?: string;
  domain_name: string;
  user_id: string | PublicationUser;
  profile_image?: string;
  created_at: string;
  updated_at: string;
  subscription_count?: number;
}

export interface EventVenue {
  placeDesc?: string;
  [key: string]: any;
}

export interface ConfirmationEmailSettings {
  /** Custom email subject line (max 200 chars). Falls back to platform default if omitted. */
  subject?: string;
  /** Draft.js raw JSON stringified. Rendered as the "A note from the organiser" section. */
  message?: string;
}

export interface Event {
  id: string;
  event_name: string;
  event_description?: string;
  owner_id: string;
  event_url: string;
  status: "draft" | "published" | "cancelled";
  /** Null when the event date is "to be disclosed" (TBD). */
  start_date: string | null;
  start_time: string | null;
  end_date: string | null;
  end_time: string | null;
  is_physical: boolean;
  is_online: boolean;
  venue?: EventVenue;
  checkout_fields?: Array<{
    id: string;
    label: string;
    type:
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
    required: boolean;
    options?: Array<{ label: string; value: string }>;
    position: number;
  }>;
  cover_image?: string;
  confirmation_email?: ConfirmationEmailSettings | null;
  created_at: string;
  updated_at: string;
}

export interface EventTicket {
  id: string;
  event_id: string;
  ticket_name: string;
  ticket_price: number;
  available_quantity: number;
  quantity_sold: number;
  ticket_is_limited_stock: boolean;
}

export interface Customer {
  id: string;
  firstname: string;
  lastname: string;
  email: string;
  phone_number?: string;
  gender?: string;
}

export interface Order {
  id: string;
  customer_id: string;
  event_id: string;
  total_amount: number;
  subtotal_amount?: number | null;
  discount_amount?: number;
  surcharge_amount?: number;
  currency?: string;
  discount_code?: string | null;
  discount_details?: Array<{
    rule_id: string;
    mode: "flat" | "percent";
    value: number;
    amount: number;
    coupon_code?: string;
    message?: string;
  }>;
  payment_reference: string;
  created_at?: string;
}

export interface IssuedTicketRecord {
  id: string;
  order_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone?: string;
  customer_gender?: string;
  customer_custom_fields?: Record<string, string>;
  ticket_name: string;
  ticket_price: number;
  entry_code: string;
  qr_code: string;
  event_id: string;
  created_at?: string;
}

export interface Recipient {
  full_name: string;
  email: string;
  phone_number?: string;
  gender?: string;
  custom_answers?: Record<string, string>;
  ticketId: string; // gift ticket id
}

export interface IssuedTicketView {
  eventName: string;
  ticketName: string;
  ticketPrice: number;
  address: string;
  eventDate: string;
  orderId: string;
  id: string; // order id or ticket id in gifting
  customerName: string;
  orderDate: string;
  time: string;
  date: string;
  ticketEntryCode: string;
  qrCode: string;
  customer_email?: string;
  customer_phone?: string;
  customer_gender?: string;
  customer_custom_fields?: Record<string, string>;
}

export interface TicketSale {
  id: string;
  order: Order;
  ticket: EventTicket;
  quantity_sold: number;
  sale_date: string;
}

export interface Post {
  id: string;
  title: string;
  subtitle?: string;
  body: string;
  publication: string;
  status: "draft" | "published" | "scheduled";
  publish_type?: "now" | "later";
  publish_time?: string;
  cover_image?: string;
  user_id: string;
  created_at: string;
  updated_at: string;

  visibility?: "public" | "free_subscribers" | "paid_subscribers";
}
