-- Delivery: flat-rate delivery methods, zip-keyed delivery zones, and
-- carrier shipment/tracking records. Ported from src/services/store.service.ts's
-- delivery sections (methods CRUD ~11765-11958, zone CRUD/match ~12186-12281)
-- and src/services/delivery/{delivery.service.ts,providers/shipbubble.provider.ts,types.ts}
-- - this logic lives inside the legacy "store" god-service, not its own
-- module, despite the standalone delivery.service.ts (38 lines) looking
-- like the whole feature. Verified against the live storefront checkout
-- (Surge-fe CartCheckout.tsx/FullPageCheckout.tsx) and merchant settings
-- (DeliverySettings.tsx, DeliveryZonesSettings.tsx).
--
-- Redesigned, not ported, in one place: legacy's 20260729 migration
-- collapsed store_delivery_zones into store_delivery_methods (is_zone
-- boolean discriminator), which its own comments admit was a workaround
-- ("zones aren't sorted the same way") requiring a fee<->price translation
-- shim at every read/write boundary. PROPOSED_TABLE_INVENTORY.md already
-- specifies these as two separate tables (app.delivery_methods,
-- app.delivery_zones) - this migration follows that, not legacy's shim.
--
-- app.deliveries attaches to the already-built fulfillment domain's
-- app.fulfillments (method in ('shipping','delivery')) rather than
-- duplicating order/line references - a fulfillment's plain
-- trackingReference text field is not enough to carry a carrier, quote,
-- label, or event history, which is what this table adds.
--
-- Scope: merchant-authenticated endpoints only. Legacy's public storefront
-- reads (getPublicDeliveryMethods, getPublicDeliveryZoneMatch,
-- getPublicDeliveryRates) are not built here - no next/ domain has an
-- anonymous/public read path yet (checked products, pricing, stores); that
-- is a cross-cutting gap bigger than this domain, not solved ad-hoc here.

insert into app.permissions ("code", "description") values
  ('delivery.read', 'View delivery methods, zones, and shipments'),
  ('delivery.manage', 'Manage delivery methods, zones, and shipments')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('delivery.read', 'delivery.manage')
on conflict do nothing;

alter table app.stores add column "carrierDeliveryEnabled" boolean not null default false;

-- Shipbubble joins the provider-events domain's webhook-provider set.
alter table app.provider_events drop constraint provider_events_provider_check;
alter table app.provider_events add constraint provider_events_provider_check check ("provider" in ('paystack', 'flutterwave', 'anchor', 'brails', 'shipbubble'));

create table app.delivery_methods (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "name" text not null check (length(trim("name")) between 1 and 150),
  "description" text,
  "priceMinor" bigint not null default 0 check ("priceMinor" >= 0),
  "estimatedTime" text,
  "isActive" boolean not null default true,
  "sortOrder" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict
);

create index delivery_methods_store_idx on app.delivery_methods ("businessId", "storeId", "isActive", "sortOrder");

create trigger delivery_methods_set_updated_at before update on app.delivery_methods
  for each row execute function app.set_updated_at();

alter table app.delivery_methods enable row level security;
create policy delivery_methods_read on app.delivery_methods for select
  using (app.has_business_permission("businessId", 'delivery.read'));
create policy delivery_methods_write on app.delivery_methods for all
  using (app.has_business_permission("businessId", 'delivery.manage'))
  with check (app.has_business_permission("businessId", 'delivery.manage'));

grant select, insert, update, delete on app.delivery_methods to surge_app;

create table app.delivery_zones (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "storeId" uuid not null,
  "locationId" uuid not null,
  "zipCode" text not null check (length(trim("zipCode")) between 1 and 60),
  "feeMinor" bigint not null default 0 check ("feeMinor" >= 0),
  "minOrderMinor" bigint check ("minOrderMinor" is null or "minOrderMinor" >= 0),
  "estimatedMinutes" integer check ("estimatedMinutes" is null or "estimatedMinutes" > 0),
  "isActive" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("storeId", "locationId", "zipCode"),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("locationId", "businessId") references app.locations ("id", "businessId") on delete restrict
);

create index delivery_zones_match_idx on app.delivery_zones ("storeId", "locationId", "zipCode") where "isActive";

create trigger delivery_zones_set_updated_at before update on app.delivery_zones
  for each row execute function app.set_updated_at();

alter table app.delivery_zones enable row level security;
create policy delivery_zones_read on app.delivery_zones for select
  using (app.has_business_permission("businessId", 'delivery.read'));
create policy delivery_zones_write on app.delivery_zones for all
  using (app.has_business_permission("businessId", 'delivery.manage'))
  with check (app.has_business_permission("businessId", 'delivery.manage'));

grant select, insert, update, delete on app.delivery_zones to surge_app;

create table app.deliveries (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "orderId" uuid not null,
  "fulfillmentId" uuid,
  "storeId" uuid not null,
  "deliveryMethodId" uuid,
  "provider" text check ("provider" is null or "provider" in ('shipbubble')),
  "status" text not null default 'pending' check ("status" in ('pending', 'booked', 'in_transit', 'delivered', 'failed', 'cancelled')),
  "courierName" text,
  "serviceCode" text,
  "courierId" text,
  "trackingCode" text,
  "trackingUrl" text,
  "labelUrl" text,
  "feeMinor" bigint not null default 0 check ("feeMinor" >= 0),
  "destination" jsonb not null check (jsonb_typeof("destination") = 'object'),
  "events" jsonb not null default '[]'::jsonb check (jsonb_typeof("events") = 'array'),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict,
  foreign key ("fulfillmentId", "businessId") references app.fulfillments ("id", "businessId") on delete restrict,
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("deliveryMethodId", "businessId") references app.delivery_methods ("id", "businessId") on delete restrict
);

create index deliveries_order_idx on app.deliveries ("businessId", "orderId");
create index deliveries_tracking_idx on app.deliveries ("trackingCode") where "trackingCode" is not null;

create trigger deliveries_set_updated_at before update on app.deliveries
  for each row execute function app.set_updated_at();

alter table app.deliveries enable row level security;
create policy deliveries_read on app.deliveries for select
  using (app.has_business_permission("businessId", 'delivery.read'));
create policy deliveries_write on app.deliveries for insert
  with check (app.has_business_permission("businessId", 'delivery.manage'));
create policy deliveries_update on app.deliveries for update
  using (app.has_business_permission("businessId", 'delivery.manage'))
  with check (app.has_business_permission("businessId", 'delivery.manage'));

grant select, insert, update on app.deliveries to surge_app;

-- Reconciles a Shipbubble tracking-status webhook by trackingCode, the same
-- anonymous-caller problem (and security-definer escape hatch) as the
-- Paystack/Flutterwave checkout and communication-credit webhook paths -
-- provider-events runs every webhook as surge_app with no caller business
-- context.
create or replace function app.update_delivery_from_webhook(target_tracking_code text, new_status text, new_event jsonb)
returns table ("found" boolean, "businessId" uuid, "orderId" uuid)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_delivery_id uuid;
  v_business_id uuid;
  v_order_id uuid;
begin
  select delivery."id", delivery."businessId", delivery."orderId" into v_delivery_id, v_business_id, v_order_id
    from app.deliveries delivery where delivery."trackingCode" = target_tracking_code for update;

  if not found then
    return query select false, null::uuid, null::uuid;
    return;
  end if;

  update app.deliveries set "status" = new_status, "events" = "events" || jsonb_build_array(new_event) where "id" = v_delivery_id;

  return query select true, v_business_id, v_order_id;
end;
$$;

revoke all on function app.update_delivery_from_webhook(text, text, jsonb) from public;
grant execute on function app.update_delivery_from_webhook(text, text, jsonb) to surge_app;
