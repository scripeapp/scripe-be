-- Rollback 0061: tear down the booking engine tables/functions/policies and
-- restore app.bookings productId/durationMinutes (backfilled from items) so 0060
-- down can hand back the exact 0056 shape.

-- 1. Status-sync machinery.
drop trigger if exists bookings_status_sync_trigger on app.bookings;
drop function if exists app.sync_booking_item_status();

-- 2. Booking RLS policies (booking_items policies drop with the table).
drop policy if exists bookings_read on app.bookings;
drop policy if exists bookings_insert on app.bookings;
drop policy if exists bookings_update on app.bookings;
alter table app.bookings disable row level security;

drop policy if exists product_service_settings_booking_read on app.product_service_settings;
drop policy if exists staff_profiles_booking_read on app.staff_profiles;
drop policy if exists staff_services_booking_read on app.staff_services;
drop policy if exists staff_schedules_booking_read on app.staff_schedules;
drop policy if exists schedule_exceptions_booking_read on app.schedule_exceptions;
drop policy if exists locations_booking_read on app.locations;

drop function if exists app.reserve_booking_from_public(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, text, text, integer);

-- 3. Booking permission codes.
delete from app.role_permissions
where "permissionId" in (select "id" from app.permissions where "code" in ('booking.read', 'booking.create', 'booking.update'));
delete from app.permissions
where "code" in ('booking.read', 'booking.create', 'booking.update');

-- 4. Restore productId/durationMinutes on bookings, backfilled from the items.
alter table app.bookings
  add column "productId" uuid,
  add column "durationMinutes" integer;

update app.bookings booking
set "productId" = items."productId",
    "durationMinutes" = items."durationMinutes"
from (
  select distinct on ("bookingId") "bookingId", "productId", "durationMinutes"
  from app.booking_items
  order by "bookingId", "position"
) items
where items."bookingId" = booking."id";

alter table app.bookings
  alter column "productId" set not null,
  add constraint bookings_productId_fkey
    foreign key ("productId") references app.products ("id") on delete cascade;
create index bookings_product_idx on app.bookings ("productId");

drop table app.booking_items;

-- 5. Composite-unique plumbing this migration added.
alter table app.bookings drop constraint bookings_id_business_unique;
alter table app.staff_profiles drop constraint staff_profiles_id_business_unique;