drop index if exists app.orders_idempotency_key_unique;
alter table app.orders drop column "idempotencyKey", drop column "posDeviceId", drop column "operatorStaffId";
alter table app.register_shifts drop column "posDeviceId", drop column "closedByStaffId", drop column "openedByStaffId";
drop policy if exists staff_profiles_device_read on app.staff_profiles;
alter table app.staff_profiles drop column "tillLocationId", drop column "pinHash", drop column "tillEnabled";
drop function if exists app.pair_pos_device(text, text, text, text);
drop function if exists app.resolve_pos_device(text);

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
grant execute on function app.has_business_permission(uuid, text) to scripe_app;

drop function if exists app.device_permissions();
drop function if exists app.current_device_id();
-- register_shifts."openedByMembershipId" is left nullable: device-opened
-- shifts may exist and have no membership to restore.
