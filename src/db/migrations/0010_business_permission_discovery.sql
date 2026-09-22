-- Business discovery queries may span a user's active businesses. The
-- service still sets app.business_id for every business-scoped workflow; this
-- function deliberately authorizes against the explicit target tenant so a
-- list query can return each permitted business in one statement.
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
  );
$$;

revoke all on function app.has_business_permission(uuid, text) from public;
grant execute on function app.has_business_permission(uuid, text) to surge_app;
