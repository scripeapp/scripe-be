-- Phase 1 booking engine (SERVICE_BOOKINGS_DESIGN.md § Booking engine, § Existing
-- bookings work). Evolves app.bookings (0056) to the agreed target model:
--   - status lifecycle held|pending|confirmed|arrived|in_service|completed|cancelled|no_show
--   - UTC startsAt/endsAt (whole visit incl. buffers), backfilled from the old
--     bookingDate/startTime/endTime across the store's timezone, then the text
--     columns are dropped
--   - locationId, source, holdExpiresAt (online checkout only) and, for the
--     customer's own reschedule/cancel link, manageToken
-- productId/durationMinutes stay on app.bookings through this migration: 0061
-- backfills app.booking_items from them and drops them there. app.bookings is
-- intentionally still NOT under RLS in this migration; 0061 flips RLS on it
-- together with booking_items.

-- 1. Status lifecycle.
alter table app.bookings drop constraint bookings_status_check;
update app.bookings set "status" = 'cancelled' where "status" = 'declined';
update app.bookings set "status" = 'confirmed' where "status" = 'rescheduled';
alter table app.bookings add constraint bookings_status_check
  check ("status" in ('held', 'pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show'));

-- 2. New columns (startsAt/endsAt added nullable, backfilled, then constrained).
alter table app.bookings
  add column "locationId" uuid references app.locations ("id") on delete set null,
  add column "source" text check ("source" in ('dashboard', 'pos', 'online', 'walk_in')),
  add column "startsAt" timestamptz,
  add column "endsAt" timestamptz,
  add column "holdExpiresAt" timestamptz,
  add column "manageToken" text,
  add column "notes" text,
  add column "cancelledReason" text;

-- 3. Backfill. bookingDate + 'HH:mm' are local store times; reinterpret them
--    across the store's timezone (booking.timezone mirrors it with the same
--    Africa/Lagos default).
update app.bookings booking
set "startsAt" = (booking."bookingDate" + booking."startTime"::time)
    at time zone coalesce(nullif(store."timezone", ''), booking."timezone", 'Africa/Lagos'),
    "endsAt" = (booking."bookingDate" + booking."endTime"::time)
    at time zone coalesce(nullif(store."timezone", ''), booking."timezone", 'Africa/Lagos')
from app.stores store
where store."id" = booking."storeId";

update app.bookings set "cancelledReason" = "declineReason" where "declineReason" is not null;
update app.bookings set "source" = case when "initiatedBy" = 'customer' then 'online' else 'dashboard' end;

alter table app.bookings
  alter column "startsAt" set not null,
  alter column "endsAt" set not null,
  alter column "source" set not null,
  alter column "source" set default 'dashboard';

-- 4. Drop the text-era columns (productId/durationMinutes move to booking_items
--    in 0061, which backfills them before dropping them here).
alter table app.bookings
  drop column "bookingDate",
  drop column "startTime",
  drop column "endTime",
  drop column "timezone",
  drop column "declineReason",
  drop column "rescheduledFrom",
  drop column "expiresAt",
  drop column "locationType",
  drop column "locationDetails";

-- 5. Calendar/listing + the customer manage link.
create index bookings_business_store_start_idx on app.bookings ("businessId", "storeId", "startsAt");
create unique index bookings_manage_token_idx on app.bookings ("manageToken") where "manageToken" is not null;