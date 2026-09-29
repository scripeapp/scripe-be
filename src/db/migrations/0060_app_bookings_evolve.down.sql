-- Rollback 0060: rebuild the 0056 text-era shape from the UTC timestamps
-- (best-effort). productId/durationMinutes are untouched here — 0061 down
-- restores them from app.booking_items before dropping that table.

-- 1. Back to the old text-era columns.
alter table app.bookings
  add column "bookingDate" date,
  add column "startTime" text,
  add column "endTime" text,
  add column "timezone" text not null default 'Africa/Lagos',
  add column "declineReason" text,
  add column "rescheduledFrom" date,
  add column "expiresAt" timestamptz,
  add column "locationType" text,
  add column "locationDetails" text;

update app.bookings booking
set "timezone" = coalesce(nullif((select store."timezone" from app.stores store where store."id" = booking."storeId"), ''), 'Africa/Lagos');

update app.bookings booking
set "bookingDate" = (booking."startsAt" at time zone booking."timezone")::date,
    "startTime" = to_char(booking."startsAt" at time zone booking."timezone", 'HH24:MI'),
    "endTime" = to_char(booking."endsAt" at time zone booking."timezone", 'HH24:MI');

update app.bookings set "declineReason" = "cancelledReason" where "cancelledReason" is not null;

-- 2. Old status lifecycle.
alter table app.bookings drop constraint bookings_status_check;
update app.bookings set "status" = 'pending' where "status" = 'held';
update app.bookings set "status" = 'confirmed' where "status" in ('arrived', 'in_service');
update app.bookings set "status" = 'declined' where "status" = 'cancelled';
alter table app.bookings add constraint bookings_status_check
  check ("status" in ('pending', 'confirmed', 'declined', 'rescheduled', 'completed', 'cancelled', 'no_show'));

-- 3. Drop the evolved columns.
drop index if exists app.bookings_business_store_start_idx;
drop index if exists app.bookings_manage_token_idx;
alter table app.bookings
  drop column "locationId",
  drop column "source",
  drop column "startsAt",
  drop column "endsAt",
  drop column "holdExpiresAt",
  drop column "manageToken",
  drop column "notes",
  drop column "cancelledReason";