-- Authorization vertical slice: business invitations, membership role
-- assignment, and custom role management. Ownership assignment is out of
-- scope here — the 'owner' role can never be granted or removed through
-- this slice.

insert into app.permissions ("code", "description") values
  ('team.read', 'View team members, roles, and permissions'),
  ('team.invite', 'Invite and revoke team member invitations'),
  ('team.manage', 'Update member roles, remove members, and manage custom roles')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('team.read', 'team.invite', 'team.manage')
on conflict do nothing;

create table app.business_invitations (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "email" text not null check ("email" = lower("email")),
  "roleId" uuid not null references app.roles ("id") on delete restrict,
  "tokenHash" text not null,
  "invitedBy" uuid not null references auth.user ("id") on delete restrict,
  "expiresAt" timestamptz not null,
  "acceptedAt" timestamptz,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create unique index business_invitations_token_hash_unique on app.business_invitations ("tokenHash");
create unique index business_invitations_pending_unique on app.business_invitations ("businessId", "email")
  where "acceptedAt" is null and "revokedAt" is null;
create index business_invitations_business_idx on app.business_invitations ("businessId", "createdAt" desc);

alter table app.business_invitations enable row level security;

create policy business_invitations_read on app.business_invitations for select
  using (app.has_business_permission("businessId", 'team.read'));
create policy business_invitations_write on app.business_invitations for all
  using (app.has_business_permission("businessId", 'team.invite'))
  with check (app.has_business_permission("businessId", 'team.invite'));

grant select, insert, update on app.business_invitations to surge_app;

-- Membership lifecycle (ending a membership) and role assignment become
-- writable by authorized members. Reads were already granted in 0008.
create policy business_memberships_manage on app.business_memberships for update
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));
grant update on app.business_memberships to surge_app;

create policy membership_roles_manage on app.membership_roles for all
  using (app.has_business_permission("businessId", 'team.manage'))
  with check (app.has_business_permission("businessId", 'team.manage'));
grant insert, delete on app.membership_roles to surge_app;

-- Custom business roles. System roles (businessId is null) can never satisfy
-- has_business_permission and stay read-only through this policy.
create policy roles_manage on app.roles for all
  using ("businessId" is not null and app.has_business_permission("businessId", 'team.manage'))
  with check ("businessId" is not null and app.has_business_permission("businessId", 'team.manage'));
grant insert, update, delete on app.roles to surge_app;

create policy role_permissions_manage on app.role_permissions for all
  using (exists (
    select 1 from app.roles role
    where role."id" = "roleId" and role."businessId" is not null
      and app.has_business_permission(role."businessId", 'team.manage')
  ))
  with check (exists (
    select 1 from app.roles role
    where role."id" = "roleId" and role."businessId" is not null
      and app.has_business_permission(role."businessId", 'team.manage')
  ));
grant insert, delete on app.role_permissions to surge_app;

-- Accepting an invitation creates a membership for a user who is not yet a
-- member of the target business, so no has_business_permission check can
-- authorize it — possession of the token is the authorization. This mirrors
-- create_business_with_default_store (0009): a narrow, atomic, security
-- definer function rather than a broad insert grant.
create or replace function app.accept_business_invitation(invitation_token_hash text)
returns table (
  "membershipId" uuid,
  "businessId" uuid,
  "roleId" uuid
)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  actor_id uuid;
  found_invitation app.business_invitations%rowtype;
  new_membership_id uuid := gen_random_uuid();
begin
  actor_id := nullif(app.current_user_id(), '')::uuid;
  if actor_id is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  select invitation.* into found_invitation
  from app.business_invitations invitation
  where invitation."tokenHash" = invitation_token_hash
    and invitation."acceptedAt" is null
    and invitation."revokedAt" is null
    and invitation."expiresAt" > now()
  limit 1
  for update;

  if found_invitation."id" is null then
    return;
  end if;

  insert into app.business_memberships ("id", "businessId", "userId", "status")
  values (new_membership_id, found_invitation."businessId", actor_id, 'active');

  insert into app.membership_roles ("membershipId", "businessId", "roleId")
  values (new_membership_id, found_invitation."businessId", found_invitation."roleId");

  update app.business_invitations set "acceptedAt" = now() where "id" = found_invitation."id";

  return query select new_membership_id, found_invitation."businessId", found_invitation."roleId";
end;
$$;

revoke all on function app.accept_business_invitation(text) from public;
grant execute on function app.accept_business_invitation(text) to surge_app;
