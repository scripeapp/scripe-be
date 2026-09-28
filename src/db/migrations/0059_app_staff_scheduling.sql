-- Bookable staff (SERVICE_BOOKINGS_DESIGN.md § Team & schedules). A staff
-- member can be an existing member (has a login) or a payroll person (a party,
-- no login), which services they perform, their weekly hours per location, and
-- exceptions (time off / extra shifts). All tables follow the schema-wide RLS
-- pattern via a denormalised businessId.

create table app.staff_profiles (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "membershipId" uuid references app.business_memberships ("id") on delete set null,
  "partyId" uuid references app.parties ("id") on delete set null,
  "displayName" text not null,
  "photoUploadId" uuid references app.uploads ("id") on delete set null,
  "isBookable" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint staff_profiles_identity_present
    check ("membershipId" is not null or "partyId" is not null)
);
create index staff_profiles_business_idx on app.staff_profiles ("businessId");

create table app.staff_services (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "staffId" uuid not null references app.staff_profiles ("id") on delete cascade,
  "productId" uuid not null references app.products ("id") on delete cascade,
  "variantId" uuid references app.product_variants ("id") on delete cascade,
  "durationOverrideMinutes" integer check ("durationOverrideMinutes" > 0),
  "createdAt" timestamptz not null default now(),
  constraint staff_services_unique unique nulls not distinct ("staffId", "productId", "variantId")
);
create index staff_services_staff_idx on app.staff_services ("staffId");

create table app.staff_schedules (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "staffId" uuid not null references app.staff_profiles ("id") on delete cascade,
  "locationId" uuid not null references app.locations ("id") on delete cascade,
  "weekday" smallint not null check ("weekday" between 0 and 6),
  "startTime" text not null,
  "endTime" text not null,
  "createdAt" timestamptz not null default now()
);
create index staff_schedules_staff_idx on app.staff_schedules ("staffId");

create table app.schedule_exceptions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete cascade,
  "staffId" uuid references app.staff_profiles ("id") on delete cascade,
  "locationId" uuid references app.locations ("id") on delete cascade,
  "startsAt" timestamptz not null,
  "endsAt" timestamptz not null,
  "kind" text not null check ("kind" in ('off', 'extra')),
  "reason" text,
  "createdAt" timestamptz not null default now(),
  constraint schedule_exceptions_range check ("endsAt" > "startsAt")
);
create index schedule_exceptions_business_idx on app.schedule_exceptions ("businessId", "startsAt");

alter table app.staff_profiles enable row level security;
alter table app.staff_services enable row level security;
alter table app.staff_schedules enable row level security;
alter table app.schedule_exceptions enable row level security;

create policy staff_profiles_read on app.staff_profiles for select
  using (app.has_business_permission("businessId", 'team.read'));
create policy staff_profiles_write on app.staff_profiles for all
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));

create policy staff_services_read on app.staff_services for select
  using (app.has_business_permission("businessId", 'team.read'));
create policy staff_services_write on app.staff_services for all
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));

create policy staff_schedules_read on app.staff_schedules for select
  using (app.has_business_permission("businessId", 'team.read'));
create policy staff_schedules_write on app.staff_schedules for all
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));

create policy schedule_exceptions_read on app.schedule_exceptions for select
  using (app.has_business_permission("businessId", 'team.read'));
create policy schedule_exceptions_write on app.schedule_exceptions for all
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));

grant select, insert, update, delete on app.staff_profiles to scripe_app;
grant select, insert, update, delete on app.staff_services to scripe_app;
grant select, insert, update, delete on app.staff_schedules to scripe_app;
grant select, insert, update, delete on app.schedule_exceptions to scripe_app;
