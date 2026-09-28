-- Service settings on products (SERVICE_BOOKINGS_DESIGN.md § Services). The
-- product form already collects a duration and location type, but the backend
-- had nowhere to store them. One row per `service`-type product holds the
-- booking rules the slot engine and checkout will read.
--
-- Denormalises businessId so it follows the same row-level-security shape as
-- every other product-scoped table (e.g. app.product_prices in 0012).

create table app.product_service_settings (
  "productId" uuid primary key references app.products ("id") on delete cascade,
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "durationMinutes" integer not null check ("durationMinutes" > 0),
  "bufferBeforeMinutes" integer not null default 0 check ("bufferBeforeMinutes" >= 0),
  "bufferAfterMinutes" integer not null default 0 check ("bufferAfterMinutes" >= 0),
  "minNoticeMinutes" integer not null default 0 check ("minNoticeMinutes" >= 0),
  "maxAdvanceDays" integer not null default 60 check ("maxAdvanceDays" > 0),
  "slotIntervalMinutes" integer not null default 15 check ("slotIntervalMinutes" > 0),
  "locationType" text not null default 'in_person'
    check ("locationType" in ('in_person', 'at_customer', 'online', 'phone')),
  "requiresApproval" boolean not null default false,
  "depositRule" jsonb not null default '{"kind":"none"}'::jsonb,
  "cancellationWindowMin" integer not null default 1440 check ("cancellationWindowMin" >= 0),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index "product_service_settings_business_idx" on app.product_service_settings ("businessId");

alter table app.product_service_settings enable row level security;
create policy product_service_settings_read on app.product_service_settings for select
  using (app.has_business_permission("businessId", 'product.read'));
create policy product_service_settings_write on app.product_service_settings for all
  using (app.has_business_permission("businessId", 'product.update'))
  with check (app.has_business_permission("businessId", 'product.update'));

grant select, insert, update, delete on app.product_service_settings to scripe_app;

-- Add-ons can lengthen a booking: "Beard trim +₦3,000" also adds 15 minutes.
alter table app.modifier_options
  add column "extraDurationMinutes" integer not null default 0 check ("extraDurationMinutes" >= 0);
