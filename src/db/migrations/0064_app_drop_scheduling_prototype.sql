-- Phase 1 of the service-booking engine replaces the 0057 scheduling prototype:
-- an "event type" is now just a service product with product_service_settings, and
-- weekly availability is per-staff in app.staff_schedules. The prototype tables
-- carried everything in a data jsonb; before dropping them, seed a bookable staff
-- member's week from the business's active availability profiles so no schedule is
-- lost. Seeding is best-effort: it only lands schedules the data can support (an
-- enabled day with ranges, plus at least one location to attach the schedule to).

insert into app.staff_schedules (
  "businessId", "staffId", "locationId", "weekday", "startTime", "endTime", "createdAt"
)
select
  staff_profile."businessId",
  staff_profile."id",
  fallback_location."id",
  case schedule_day ->> 'day'
    when 'Sunday' then 0
    when 'Monday' then 1
    when 'Tuesday' then 2
    when 'Wednesday' then 3
    when 'Thursday' then 4
    when 'Friday' then 5
    when 'Saturday' then 6
  end,
  day_range ->> 'startTime',
  day_range ->> 'endTime',
  now()
from app.staff_profiles staff_profile
join app.availability_profiles availability_profile
  on availability_profile."businessId" = staff_profile."businessId"
 and availability_profile."status" = 'active'
cross join lateral jsonb_array_elements(
  case jsonb_typeof(availability_profile."data" -> 'weekly_schedule')
    when 'array' then availability_profile."data" -> 'weekly_schedule'
    else '[]'::jsonb
  end
) schedule_day
cross join lateral jsonb_array_elements(
  case jsonb_typeof(schedule_day -> 'ranges')
    when 'array' then schedule_day -> 'ranges'
    else '[]'::jsonb
  end
) day_range
cross join lateral (
  select store_location."id"
  from app.locations store_location
  where store_location."businessId" = staff_profile."businessId"
  order by store_location."createdAt"
  limit 1
) fallback_location
where staff_profile."isBookable" = true
  and coalesce((schedule_day ->> 'isEnabled')::boolean, false) = true
  and (schedule_day ->> 'day') is not null
  and coalesce(day_range ->> 'startTime', '') <> ''
  and coalesce(day_range ->> 'endTime', '') <> '';

drop table app.event_types;
drop table app.availability_profiles;