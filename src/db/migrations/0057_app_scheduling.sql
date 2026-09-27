-- Scheduling for service products (salons, stylists, consultants): reusable
-- weekly availability profiles and bookable event types. Both carry rich,
-- evolving nested settings, so the flexible fields live in a `data` jsonb and
-- only the columns needed for listing/lookup are promoted.
--
-- Like app.bookings, these are dashboard-only, business-scoped resources whose
-- access is enforced in the service layer (auth + permission + businessId
-- filter), so they are intentionally not under RLS. Explicit grants below.

create table app.availability_profiles (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "name" text not null,
  "status" text not null default 'active' check ("status" in ('active', 'inactive')),
  "data" jsonb not null default '{}'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);
create index "availability_profiles_business_idx" on app.availability_profiles ("businessId");
grant select, insert, update, delete on app.availability_profiles to scripe_app;

create table app.event_types (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "slug" text not null,
  "title" text not null,
  "isActive" boolean not null default true,
  "availabilityProfileId" uuid references app.availability_profiles ("id") on delete set null,
  "data" jsonb not null default '{}'::jsonb,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "slug")
);
create index "event_types_business_idx" on app.event_types ("businessId");
grant select, insert, update, delete on app.event_types to scripe_app;
