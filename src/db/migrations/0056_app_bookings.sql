-- Service bookings: a customer reserves a time slot for a service product at
-- checkout, and the merchant confirms / declines / completes it. The frontend
-- (BookingCalendar, BookingsTab, OrderDetails) already speaks to these; this
-- adds the missing storage + endpoints.
--
-- Access is enforced in the service layer: the dashboard list/status endpoints
-- require an authenticated business member with the right permission and filter
-- every query by businessId, while `reserve` is a public storefront action
-- (shoppers are not members). Because a public insert cannot satisfy a
-- member-permission RLS policy, this table is intentionally NOT under RLS and is
-- reached only through those service-layer-guarded queries, with explicit grants
-- to the runtime role below.

create table app.bookings (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "storeId" uuid not null references app.stores ("id") on delete cascade,
  "productId" uuid not null references app.products ("id") on delete cascade,
  "orderId" uuid references app.orders ("id") on delete set null,
  "customerPartyId" uuid references app.parties ("id") on delete set null,
  "customerName" text,
  "customerEmail" text,
  "customerPhone" text,
  "bookingDate" date not null,
  "startTime" text not null,
  "endTime" text not null,
  "timezone" text not null default 'Africa/Lagos',
  "locationType" text,
  "locationDetails" text,
  "requiresApproval" boolean not null default false,
  "durationMinutes" integer,
  "status" text not null default 'pending'
    check ("status" in ('pending', 'confirmed', 'declined', 'rescheduled', 'completed', 'cancelled', 'no_show')),
  "declineReason" text,
  "rescheduledFrom" date,
  "initiatedBy" text check ("initiatedBy" in ('creator', 'customer')),
  "expiresAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index "bookings_business_store_idx" on app.bookings ("businessId", "storeId");
create index "bookings_product_idx" on app.bookings ("productId");
create index "bookings_order_idx" on app.bookings ("orderId");

grant select, insert, update on app.bookings to scripe_app;
