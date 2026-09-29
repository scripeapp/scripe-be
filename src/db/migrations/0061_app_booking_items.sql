-- Phase 1 booking engine (SERVICE_BOOKINGS_DESIGN.md § Slot engine, § Security &
-- tenant isolation). App.booking_items carries the per-service booked intervals
-- (staff, product, exact UTC window, price) and the hard availability guarantee:
-- a gist EXCLUSION CONSTRAINT over (staffId, [startsAt, endsAt)) rejects any
-- overlapping active booking for the same staff — even under concurrent writes.
-- btree_gist supplies the uuid equality operator the exclusion constraint needs.
--
-- Also on this migration:
--   - booking.* permission codes (owner-granted, same pattern as 0022)
--   - RLS flipped ON for app.bookings (0056 deliberately skipped it) and for
--     app.booking_items, via the shared app.has_business_permission(...)
--   - read-only booking.read policies on the scheduling/settings tables the slot
--     engine reads (staff_schedules, schedule_exceptions, staff_profiles,
--     staff_services, product_service_settings, locations)
--   - app.reserve_booking_from_public (...) — the storefront reserve endpoint is
--     unauthenticated, so the public insert runs as a SECURITY DEFINER function
--     (owner bypasses RLS, and the owner is a trusted migration role — the same
--     technique as the webhook functions in 0029/0030). Validations that need a
--     businessId live INSIDE the definer function, which revokes public execute
--     and grants execute only to scripe_app.

-- 0. Constraint plumbing the new FKs need: booking_items joins bookings and
--    staff_profiles on (id, businessId).
alter table app.bookings
  add constraint bookings_id_business_unique unique ("id", "businessId");
alter table app.staff_profiles
  add constraint staff_profiles_id_business_unique unique ("id", "businessId");

-- 1. The hard bookability guarantee.
create extension if not exists btree_gist;

-- 2. Permissions.
insert into app.permissions ("code", "description") values
  ('booking.read', 'View bookings and available slots'),
  ('booking.create', 'Create bookings'),
  ('booking.update', 'Confirm, reschedule or cancel bookings')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('booking.read', 'booking.create', 'booking.update')
on conflict do nothing;

-- 3. Booking items.
create table app.booking_items (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "bookingId" uuid not null,
  "position" integer not null default 0 check ("position" >= 0),
  "productId" uuid not null,
  "variantId" uuid,
  "staffId" uuid,
  "startsAt" timestamptz not null,
  "endsAt" timestamptz not null,
  "modifierOptionIds" uuid[] not null default '{}',
  "priceMinor" bigint not null default 0 check ("priceMinor" >= 0),
  "durationMinutes" integer not null check ("durationMinutes" > 0),
  "status" text not null default 'held'
    check ("status" in ('held', 'pending', 'confirmed', 'arrived', 'in_service', 'completed', 'cancelled', 'no_show')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint booking_items_booking_fk
    foreign key ("bookingId", "businessId") references app.bookings ("id", "businessId") on delete cascade,
  constraint booking_items_product_fk
    foreign key ("productId", "businessId") references app.products ("id", "businessId") on delete restrict,
  constraint booking_items_staff_fk
    foreign key ("staffId", "businessId") references app.staff_profiles ("id", "businessId") on delete set null
);

-- One staff member can never be double-booked for two ACTIVE items: any attempt
-- whose window overlaps an existing one raises SQLSTATE 23P01 (exclusion_violation).
alter table app.booking_items
  add constraint booking_items_no_overlap
    exclude using gist ("staffId" with =, tstzrange ("startsAt", "endsAt", '[)') with &&)
    where ("status" in ('held', 'pending', 'confirmed', 'arrived', 'in_service'));

create index booking_items_business_range_idx on app.booking_items ("businessId", "staffId", "startsAt");
create index booking_items_booking_idx on app.booking_items ("bookingId");

-- 4. Backfill existing 0056 bookings as single-item rows (they predate staff
--    assignment, so staffId stays NULL), then drop productId/durationMinutes
--    from bookings — booking.types no longer models them.
insert into app.booking_items (
  "businessId", "bookingId", "position", "productId", "staffId",
  "startsAt", "endsAt", "status", "durationMinutes", "priceMinor"
)
select b."businessId", b."id", 0, b."productId", null,
       b."startsAt", b."endsAt", b."status",
       coalesce(b."durationMinutes", pss."durationMinutes", 30), 0
from app.bookings b
left join app.product_service_settings pss on pss."productId" = b."productId";

alter table app.bookings
  drop column "productId",
  drop column "durationMinutes";

-- 5. Booking status propagates to every item (and the exclusion constraint keeps
--    only ACTIVE statuses blocking, so a completing/cancelling frees the slot).
create function app.sync_booking_item_status() returns trigger
language plpgsql volatile
set search_path = app, pg_temp
as $$
begin
  update app.booking_items
     set "status" = new."status", "updatedAt" = now()
   where "bookingId" = new."id";
  return new;
end;
$$;

create trigger bookings_status_sync_trigger
  after update of "status" on app.bookings
  for each row when (old."status" is distinct from new."status")
  execute function app.sync_booking_item_status();

-- 6. RLS. Both tables now enforce tenant isolation through has_business_permission.
alter table app.bookings enable row level security;
alter table app.booking_items enable row level security;

create policy bookings_read on app.bookings for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy bookings_insert on app.bookings for insert
  with check (app.has_business_permission("businessId", 'booking.create'));
create policy bookings_update on app.bookings for update
  using (app.has_business_permission("businessId", 'booking.update'))
  with check (app.has_business_permission("businessId", 'booking.update'));

create policy booking_items_read on app.booking_items for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy booking_items_insert on app.booking_items for insert
  with check (app.has_business_permission("businessId", 'booking.create'));
create policy booking_items_update on app.booking_items for update
  using (app.has_business_permission("businessId", 'booking.update'))
  with check (app.has_business_permission("businessId", 'booking.update'));

-- 7. The slot engine is read-only over the scheduling/settings tables; a
--    calendar operator with booking.read (but not team.read or product.read)
--    still needs to browse them. Booking-scoped select remains write-dead silent.
create policy product_service_settings_booking_read on app.product_service_settings for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy staff_profiles_booking_read on app.staff_profiles for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy staff_services_booking_read on app.staff_services for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy staff_schedules_booking_read on app.staff_schedules for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy schedule_exceptions_booking_read on app.schedule_exceptions for select
  using (app.has_business_permission("businessId", 'booking.read'));
create policy locations_booking_read on app.locations for select
  using (app.has_business_permission("businessId", 'booking.read'));

grant select, insert, update on app.bookings to scripe_app;
grant select, insert, update on app.booking_items to scripe_app;

-- 8. The public reserve endpoint. The runtime role runs this as a trusted
--    definer: product/store/staff validations that need a businessId happen
--    here (the public caller must never be able to reach across tenants), and
--    the item insert carries the real slot; a race on the exclusion constraint
--    surfaces as 'slot_taken' after the just-created booking is rolled back.
create function app.reserve_booking_from_public(
  target_store_id uuid,
  target_product_id uuid,
  target_variant_id uuid,
  target_staff_id uuid,
  target_location_id uuid,
  target_starts_at timestamptz,
  target_customer_name text default null,
  target_customer_email text default null,
  target_customer_phone text default null,
  target_manage_token text default null,
  target_hold_minutes integer default 10
)
returns table (
  "id" uuid,
  "startsAt" timestamptz,
  "endsAt" timestamptz,
  "holdExpiresAt" timestamptz,
  "error" text
)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
  v_product_type text;
  v_base_duration integer;
  v_duration integer;
  v_min_notice integer;
  v_max_advance integer;
  v_starts timestamptz;
  v_ends timestamptz;
  v_hold_expires timestamptz;
  v_id uuid;
begin
  select s."businessId" into v_business_id
  from app.stores s
  where s."id" = target_store_id and s."status" = 'active';
  if v_business_id is null then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'store_inactive';
    return;
  end if;

  select p."productType", pss."durationMinutes", pss."minNoticeMinutes", pss."maxAdvanceDays"
    into v_product_type, v_base_duration, v_min_notice, v_max_advance
  from app.products p
  left join app.product_service_settings pss on pss."productId" = p."id"
  where p."id" = target_product_id
    and p."businessId" = v_business_id
    and p."productType" = 'service';
  if v_product_type is null then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'product_not_service';
    return;
  end if;

  if not exists (
    select 1 from app.staff_profiles sp
    where sp."id" = target_staff_id
      and sp."businessId" = v_business_id
      and sp."isBookable"
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'staff_unavailable';
    return;
  end if;

  if not exists (
    select 1 from app.staff_services ss
    where ss."staffId" = target_staff_id
      and ss."businessId" = v_business_id
      and ss."productId" = target_product_id
      and (target_variant_id is null or ss."variantId" is null or ss."variantId" = target_variant_id)
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'staff_does_not_perform';
    return;
  end if;

  if target_location_id is not null and not exists (
    select 1 from app.locations loc
    where loc."id" = target_location_id and loc."businessId" = v_business_id
  ) then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'location_unknown';
    return;
  end if;

  -- Duration is decided server-side: a staff-specific override beats the
  -- product's standard duration; the client never supplies it.
  select ss."durationOverrideMinutes" into v_duration
  from app.staff_services ss
  where ss."staffId" = target_staff_id
    and ss."businessId" = v_business_id
    and ss."productId" = target_product_id
    and (target_variant_id is null or ss."variantId" is null or ss."variantId" = target_variant_id)
  order by (ss."variantId" is not null) desc, (ss."variantId" = target_variant_id) desc
  limit 1;
  v_duration := coalesce(v_duration, v_base_duration);

  v_starts := date_trunc('minute', target_starts_at);
  v_ends := v_starts + (v_duration * interval '1 minute');
  v_hold_expires := now() + (greatest(1, coalesce(target_hold_minutes, 10)) * interval '1 minute');

  if v_starts < now() + (coalesce(v_min_notice, 0) * interval '1 minute') then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'too_late';
    return;
  end if;
  if v_starts > now() + (coalesce(v_max_advance, 60) * interval '1 day') then
    return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'too_far';
    return;
  end if;

  insert into app.bookings (
    "businessId", "storeId", "locationId", "customerName", "customerEmail", "customerPhone",
    "status", "source", "startsAt", "endsAt", "holdExpiresAt", "manageToken", "initiatedBy"
  ) values (
    v_business_id, target_store_id, target_location_id,
    nullif(trim(coalesce(target_customer_name, '')), ''),
    nullif(trim(coalesce(target_customer_email, '')), ''),
    nullif(trim(coalesce(target_customer_phone, '')), ''),
    'held', 'online', v_starts, v_ends, v_hold_expires, target_manage_token, 'customer'
  )
  returning "id" into v_id;

  begin
    insert into app.booking_items (
      "businessId", "bookingId", "position", "productId", "variantId", "staffId",
      "startsAt", "endsAt", "modifierOptionIds", "priceMinor", "durationMinutes", "status"
    ) values (
      v_business_id, v_id, 0, target_product_id, target_variant_id, target_staff_id,
      v_starts, v_ends, '{}'::uuid[], 0, v_duration, 'held'
    );
  exception
    when exclusion_violation then
      delete from app.bookings where "id" = v_id;
      return query select null::uuid, null::timestamptz, null::timestamptz, null::timestamptz, 'slot_taken';
      return;
  end;

  return query select v_id, v_starts, v_ends, v_hold_expires, null::text;
end;
$$;

revoke all on function app.reserve_booking_from_public(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, text, text, integer) from public;
grant execute on function app.reserve_booking_from_public(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, text, text, integer) to scripe_app;