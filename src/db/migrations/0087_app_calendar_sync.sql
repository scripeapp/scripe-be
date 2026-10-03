-- Google Calendar sync for bookings (Settings › Integrations).
--
-- The Google connection itself is the person's linked Google account in
-- auth.account (tokens and granted scopes, managed by Better Auth). These
-- tables hold what Scripe adds on top: the person's sync preferences, and the
-- Google event each booked service was copied to, so a cancellation or
-- reschedule can find it again.
--
-- Sync runs after a booking is saved and may be triggered by someone other
-- than the person whose calendar it lands on (a manager confirming a stylist's
-- booking), so it reads and records through the definer functions below.

create table app.calendar_connections (
  "userId" uuid primary key references auth.user ("id") on delete cascade,
  "meetEnabled" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create trigger calendar_connections_set_updated_at before update on app.calendar_connections
  for each row execute function app.set_updated_at();

alter table app.calendar_connections enable row level security;
create policy calendar_connections_select_own on app.calendar_connections for select
  using (app.current_user_id() = "userId"::text);
create policy calendar_connections_insert_own on app.calendar_connections for insert
  with check (app.current_user_id() = "userId"::text);
create policy calendar_connections_update_own on app.calendar_connections for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);
create policy calendar_connections_delete_own on app.calendar_connections for delete
  using (app.current_user_id() = "userId"::text);
grant select, insert, update, delete on app.calendar_connections to scripe_app;

create table app.booking_calendar_events (
  "bookingItemId" uuid primary key references app.booking_items ("id") on delete cascade,
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "userId" uuid not null references auth.user ("id") on delete cascade,
  "googleEventId" text not null,
  "meetUrl" text,
  "syncedAt" timestamptz not null default now()
);

alter table app.booking_calendar_events enable row level security;
create policy booking_calendar_events_select on app.booking_calendar_events for select
  using (app.has_business_permission("businessId", 'booking.read'));
grant select on app.booking_calendar_events to scripe_app;

-- Whose calendar each service in a booking belongs on: the booked staff
-- member's own login, or the business owner when the staff member has none.
create function app.booking_calendar_targets(target_booking_id uuid)
returns table (
  "bookingItemId" uuid, "businessId" uuid, "userId" uuid, "itemStatus" text,
  "startsAt" timestamptz, "endsAt" timestamptz, "serviceName" text, "staffName" text,
  "businessName" text, "locationName" text, "timezone" text,
  "customerName" text, "customerEmail" text, "notes" text,
  "meetEnabled" boolean, "googleEventId" text, "eventUserId" uuid
)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select i."id", i."businessId",
         coalesce(m."userId", biz."createdBy"),
         i."status", i."startsAt", i."endsAt", p."name", sp."displayName",
         biz."displayName", l."name", coalesce(st."timezone", 'Africa/Lagos'),
         b."customerName", b."customerEmail", b."notes",
         coalesce(cc."meetEnabled", true),
         e."googleEventId", e."userId"
  from app.booking_items i
  join app.bookings b on b."id" = i."bookingId"
  join app.businesses biz on biz."id" = i."businessId"
  join app.products p on p."id" = i."productId"
  left join app.staff_profiles sp on sp."id" = i."staffId"
  left join app.business_memberships m on m."id" = sp."membershipId" and m."status" = 'active'
  left join app.locations l on l."id" = b."locationId"
  left join app.stores st on st."id" = b."storeId"
  left join app.calendar_connections cc on cc."userId" = coalesce(m."userId", biz."createdBy")
  left join app.booking_calendar_events e on e."bookingItemId" = i."id"
  where i."bookingId" = target_booking_id
  order by i."position";
$$;
revoke all on function app.booking_calendar_targets(uuid) from public;
grant execute on function app.booking_calendar_targets(uuid) to scripe_app;

create function app.record_booking_calendar_event(
  target_item_id uuid, target_business_id uuid, target_user_id uuid, target_event_id text, target_meet_url text
)
returns void
language sql
volatile
security definer
set search_path = app, pg_temp
as $$
  insert into app.booking_calendar_events ("bookingItemId", "businessId", "userId", "googleEventId", "meetUrl")
  values (target_item_id, target_business_id, target_user_id, target_event_id, target_meet_url)
  on conflict ("bookingItemId") do update
    set "userId" = excluded."userId", "googleEventId" = excluded."googleEventId",
        "meetUrl" = excluded."meetUrl", "syncedAt" = now();
$$;
revoke all on function app.record_booking_calendar_event(uuid, uuid, uuid, text, text) from public;
grant execute on function app.record_booking_calendar_event(uuid, uuid, uuid, text, text) to scripe_app;

create function app.forget_booking_calendar_event(target_item_id uuid)
returns void
language sql
volatile
security definer
set search_path = app, pg_temp
as $$
  delete from app.booking_calendar_events where "bookingItemId" = target_item_id;
$$;
revoke all on function app.forget_booking_calendar_event(uuid) from public;
grant execute on function app.forget_booking_calendar_event(uuid) to scripe_app;

-- For the slot finder: which login's Google busy times block each staff member.
create function app.staff_calendar_users(target_business_id uuid, target_staff_ids uuid[])
returns table ("staffId" uuid, "userId" uuid)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select sp."id", m."userId"
  from app.staff_profiles sp
  join app.business_memberships m on m."id" = sp."membershipId" and m."status" = 'active'
  where sp."businessId" = target_business_id and sp."id" = any(target_staff_ids)
    and app.has_business_permission(target_business_id, 'booking.read');
$$;
revoke all on function app.staff_calendar_users(uuid, uuid[]) from public;
grant execute on function app.staff_calendar_users(uuid, uuid[]) to scripe_app;
