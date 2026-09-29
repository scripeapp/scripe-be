-- Every business's owner is now bookable from day one, with Monday–Friday
-- 09:00–17:00 at the default store's default branch (seedOwnerAsStaff in
-- staff.service.ts, called when a business is created), so a one-person
-- business can take bookings without setting up staff first. This backfills
-- owners who don't have a staff profile yet. Weekday 0 is Sunday; times are
-- the branch's local time.

with owners as (
  select distinct on (membership."id")
    membership."businessId",
    membership."id" as "membershipId",
    coalesce(nullif(trim(owner_user."name"), ''), owner_user."email", 'Owner') as "displayName"
  from app.business_memberships membership
  join app.membership_roles membership_role on membership_role."membershipId" = membership."id"
  join app.roles role on role."id" = membership_role."roleId" and role."code" = 'owner'
  join auth."user" owner_user on owner_user."id" = membership."userId"
  where membership."status" = 'active'
    and not exists (
      select 1 from app.staff_profiles existing
      where existing."businessId" = membership."businessId" and existing."membershipId" = membership."id"
    )
),
created as (
  insert into app.staff_profiles ("businessId", "membershipId", "displayName", "isBookable")
  select "businessId", "membershipId", "displayName", true from owners
  returning "id", "businessId"
)
insert into app.staff_schedules ("businessId", "staffId", "locationId", "weekday", "startTime", "endTime")
select created."businessId", created."id", branch."id", weekday, '09:00', '17:00'
from created
join app.stores store on store."businessId" = created."businessId" and store."isDefault" and store."status" <> 'archived'
join app.locations branch
  on branch."storeId" = store."id" and branch."isDefault" and branch."status" <> 'archived'
cross join generate_series(1, 5) as weekday;
