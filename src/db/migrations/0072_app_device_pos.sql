-- Cashier devices (the /pos app) and till staff.
--
-- A paired device acts as its register without any user login. It gets its
-- own principal (app.device_id) and a fixed, narrow set of permissions in
-- its own business only, checked by the same has_business_permission every
-- RLS policy already uses — so nothing about user access changes.
--
-- Till staff are staff profiles (with or without a login) with till access
-- switched on and a PIN. Every device sale and shift records which staff
-- profile did it.

-- 1. Device principal ------------------------------------------------------
create or replace function app.current_device_id() returns text
language sql stable
as $$
  select nullif(current_setting('app.device_id', true), '');
$$;
grant execute on function app.current_device_id() to scripe_app, scripe_worker;

-- What a paired till may do. Deliberately short: sell, run its shifts, read
-- the catalogue, customers, orders and bookings it serves.
create or replace function app.device_permissions() returns text[]
language sql immutable
as $$
  select array[
    'store.read', 'product.read', 'pricing.read', 'promotion.read',
    'order.create', 'order.read', 'payment.manage', 'payment.read', 'receipt.read',
    'register.operate', 'party.read', 'party.manage', 'booking.read', 'booking.update',
    'inventory.read'
  ]::text[];
$$;
grant execute on function app.device_permissions() to scripe_app, scripe_worker;

create or replace function app.has_business_permission(target_business_id uuid, permission_code text)
returns boolean
language sql stable security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1
    from app.business_memberships membership
    join app.businesses business on business."id" = membership."businessId" and business."status" = 'active'
    join app.membership_roles membership_role
      on membership_role."membershipId" = membership."id"
     and membership_role."businessId" = membership."businessId"
    join app.role_permissions role_permission on role_permission."roleId" = membership_role."roleId"
    join app.permissions permission on permission."id" = role_permission."permissionId"
    where membership."businessId" = target_business_id
      and membership."userId"::text = app.current_user_id()
      and membership."status" = 'active'
      and permission."code" = permission_code
  )
  or exists (
    select 1
    from app.pos_devices device
    join app.businesses business on business."id" = device."businessId" and business."status" = 'active'
    where device."id"::text = app.current_device_id()
      and device."businessId" = target_business_id
      and device."status" = 'active'
      and permission_code = any(app.device_permissions())
  );
$$;
revoke all on function app.has_business_permission(uuid, text) from public;
grant execute on function app.has_business_permission(uuid, text) to scripe_app;

-- A device token is a bearer credential: resolving it happens before any
-- principal exists, so it runs as a definer function over the hash only.
create or replace function app.resolve_pos_device(target_token_hash text)
returns table ("deviceId" uuid, "businessId" uuid, "storeId" uuid, "registerId" uuid, "locationId" uuid)
language plpgsql security definer
set search_path = app, pg_temp
as $$
begin
  return query
    update app.pos_devices device
       set "lastSeenAt" = now()
      from app.registers register
     where device."tokenHash" = target_token_hash
       and device."status" = 'active'
       and register."id" = device."registerId"
       and register."status" = 'active'
    returning device."id", device."businessId", device."storeId", device."registerId", register."locationId";
end;
$$;
revoke all on function app.resolve_pos_device(text) from public;
grant execute on function app.resolve_pos_device(text) to scripe_app;

-- Swaps a one-time pairing code for a device token. Returns nothing for an
-- unknown or expired code.
create or replace function app.pair_pos_device(target_code_hash text, target_token_hash text, target_label text, target_platform text)
returns table ("deviceId" uuid, "businessId" uuid, "storeId" uuid, "registerId" uuid)
language plpgsql security definer
set search_path = app, pg_temp
as $$
begin
  return query
    update app.pos_devices device
       set "tokenHash" = target_token_hash,
           "status" = 'active',
           "pairingCodeHash" = null,
           "pairingCodeExpiresAt" = null,
           "pairedAt" = now(),
           "lastSeenAt" = now(),
           "label" = coalesce(nullif(trim(target_label), ''), device."label"),
           "platform" = coalesce(target_platform, device."platform")
     where device."pairingCodeHash" = target_code_hash
       and device."status" = 'pending'
       and device."pairingCodeExpiresAt" > now()
    returning device."id", device."businessId", device."storeId", device."registerId";
end;
$$;
revoke all on function app.pair_pos_device(text, text, text, text) from public;
grant execute on function app.pair_pos_device(text, text, text, text) to scripe_app;

-- 2. Till staff ------------------------------------------------------------
alter table app.staff_profiles
  add column "tillEnabled" boolean not null default false,
  add column "pinHash" text,
  add column "tillLocationId" uuid references app.locations ("id") on delete set null;

-- Till staff are read by the device's PIN screen; bookable-staff reads
-- already have their own policies.
create policy staff_profiles_device_read on app.staff_profiles for select
  using (app.has_business_permission("businessId", 'register.operate'));

-- 3. Attribution -----------------------------------------------------------
alter table app.register_shifts
  alter column "openedByMembershipId" drop not null,
  add column "openedByStaffId" uuid references app.staff_profiles ("id") on delete set null,
  add column "closedByStaffId" uuid references app.staff_profiles ("id") on delete set null,
  add column "posDeviceId" uuid references app.pos_devices ("id") on delete set null;

alter table app.orders
  add column "operatorStaffId" uuid references app.staff_profiles ("id") on delete set null,
  add column "posDeviceId" uuid references app.pos_devices ("id") on delete set null,
  add column "idempotencyKey" text;

-- A retried device sale replays the original order instead of charging twice.
create unique index orders_idempotency_key_unique on app.orders ("businessId", "idempotencyKey")
  where "idempotencyKey" is not null;
