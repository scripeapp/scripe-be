-- Reverse 0064: restore the 0057 prototype tables exactly as created (non-RLS,
-- service-layer access control) and reverse-seed one availability profile per
-- business that has staff schedules, so nothing is lost on a rollback.

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

insert into app.availability_profiles ("businessId", "name", "status", "data", "createdAt", "updatedAt")
select
  scheduled."businessId",
  'Seeded from staff schedules',
  'active',
  jsonb_build_object(
    'weekly_schedule',
    jsonb_agg(distinct jsonb_build_object(
      'day',
      case scheduled."weekday"
        when 0 then 'Sunday'
        when 1 then 'Monday'
        when 2 then 'Tuesday'
        when 3 then 'Wednesday'
        when 4 then 'Thursday'
        when 5 then 'Friday'
        when 6 then 'Saturday'
      end,
      'isEnabled', true,
      'ranges', jsonb_build_array(
        jsonb_build_object(
          'startTime', scheduled."startTime",
          'endTime', scheduled."endTime"
        )
      )
    ) order by scheduled."weekday")
  ),
  now(),
  now()
from app.staff_schedules scheduled
group by scheduled."businessId";