-- app.booking_tips: gratuities recorded when a booking is charged at the till,
-- attributed to the staff member who performed the service. One row per staff
-- per booking keeps the commission report's tipsMinor simple to sum: a reopen
-- upserts against the (bookingId, staffId) unique.
create table app.booking_tips (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "bookingId" uuid not null,
  "orderId" uuid not null,
  "staffId" uuid,
  "amountMinor" bigint not null check ("amountMinor" >= 0),
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  unique ("bookingId", "businessId", "staffId"),
  foreign key ("bookingId", "businessId") references app.bookings ("id", "businessId") on delete restrict,
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict,
  foreign key ("staffId", "businessId") references app.staff_profiles ("id", "businessId") on delete restrict
);
create index booking_tips_staff_idx on app.booking_tips ("businessId", "staffId", "createdAt");

alter table app.booking_tips enable row level security;
create policy booking_tips_read on app.booking_tips
  for select using (app.has_business_permission("businessId", 'booking.read'));
create policy booking_tips_write on app.booking_tips
  for all using (app.has_business_permission("businessId", 'booking.update'))
  with check (app.has_business_permission("businessId", 'booking.update'));

grant select, insert, update on app.booking_tips to scripe_app;