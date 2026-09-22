-- Wave B prerequisite: business tenancy, memberships, roles, and permissions.

create table app.businesses (
  "id" uuid primary key default gen_random_uuid(),
  "displayName" text not null check (length(trim("displayName")) between 1 and 160),
  "status" text not null default 'active' check ("status" in ('active', 'suspended', 'archived')),
  "defaultCurrency" text not null default 'NGN' check ("defaultCurrency" ~ '^[A-Z]{3}$'),
  "timezone" text not null default 'Africa/Lagos',
  "primaryVertical" text,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "status")
);

create table app.business_memberships (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "userId" uuid not null references auth.user ("id") on delete restrict,
  "status" text not null default 'active' check ("status" in ('invited', 'active', 'suspended', 'ended')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "endedAt" timestamptz,
  unique ("businessId", "userId"),
  unique ("id", "businessId")
);

create table app.permissions (
  "id" uuid primary key default gen_random_uuid(),
  "code" text not null unique,
  "description" text not null
);

create table app.roles (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid references app.businesses ("id") on delete restrict,
  "code" text not null,
  "name" text not null,
  "isSystem" boolean not null default false,
  "createdAt" timestamptz not null default now()
);

create unique index roles_system_code_unique on app.roles ("code") where "businessId" is null;
create unique index roles_business_code_unique on app.roles ("businessId", "code") where "businessId" is not null;

create table app.role_permissions (
  "roleId" uuid not null references app.roles ("id") on delete cascade,
  "permissionId" uuid not null references app.permissions ("id") on delete cascade,
  primary key ("roleId", "permissionId")
);

create table app.membership_roles (
  "membershipId" uuid not null,
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "roleId" uuid not null references app.roles ("id") on delete restrict,
  primary key ("membershipId", "roleId"),
  foreign key ("membershipId", "businessId")
    references app.business_memberships ("id", "businessId") on delete cascade
);

create index business_memberships_user_idx on app.business_memberships ("userId", "status");
create index business_memberships_business_idx on app.business_memberships ("businessId", "status");
create index membership_roles_business_idx on app.membership_roles ("businessId", "membershipId");

insert into app.permissions ("code", "description") values
  ('business.read', 'View a business'),
  ('business.update', 'Update business settings'),
  ('business.archive', 'Archive a business'),
  ('store.read', 'View stores and operational settings'),
  ('store.create', 'Create stores'),
  ('store.update', 'Update stores and choose the default store'),
  ('store.archive', 'Archive stores'),
  ('location.manage', 'Manage store locations'),
  ('channel.manage', 'Manage store sales channels'),
  ('register.manage', 'Manage registers and paired devices'),
  ('register.operate', 'Open and close register shifts'),
  ('cash.manage', 'Post and view register cash movements');

insert into app.roles ("businessId", "code", "name", "isSystem")
values (null, 'owner', 'Owner', true);

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id"
from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner';

create trigger businesses_set_updated_at before update on app.businesses
  for each row execute function app.set_updated_at();
create trigger business_memberships_set_updated_at before update on app.business_memberships
  for each row execute function app.set_updated_at();

create or replace function app.is_business_member(target_business_id uuid)
returns boolean
language sql stable security definer
set search_path = app, pg_temp
as $$
  select exists (
      select 1 from app.business_memberships membership
      where membership."businessId" = target_business_id
        and membership."userId"::text = app.current_user_id()
        and membership."status" = 'active'
    );
$$;

create or replace function app.has_business_permission(target_business_id uuid, permission_code text)
returns boolean
language sql stable security definer
set search_path = app, pg_temp
as $$
  select app.current_business_id() = target_business_id::text
    and exists (
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

revoke all on function app.is_business_member(uuid) from public;
revoke all on function app.has_business_permission(uuid, text) from public;
grant execute on function app.is_business_member(uuid), app.has_business_permission(uuid, text) to surge_app;

alter table app.businesses enable row level security;
alter table app.business_memberships enable row level security;
alter table app.roles enable row level security;
alter table app.permissions enable row level security;
alter table app.role_permissions enable row level security;
alter table app.membership_roles enable row level security;

create policy businesses_member_select on app.businesses for select using (app.is_business_member("id"));
create policy businesses_member_update on app.businesses for update
  using (app.has_business_permission("id", 'business.update'))
  with check (app.has_business_permission("id", 'business.update'));
create policy memberships_self_select on app.business_memberships for select
  using ("userId"::text = app.current_user_id());
create policy roles_member_select on app.roles for select
  using ("businessId" is null or app.is_business_member("businessId"));
create policy permissions_authenticated_select on app.permissions for select
  using (app.current_user_id() is not null);
create policy role_permissions_member_select on app.role_permissions for select
  using (exists (select 1 from app.roles role where role."id" = "roleId" and (role."businessId" is null or app.is_business_member(role."businessId"))));
create policy membership_roles_member_select on app.membership_roles for select
  using (app.is_business_member("businessId"));

grant select, update on app.businesses to surge_app;
grant select on app.business_memberships, app.roles, app.permissions, app.role_permissions, app.membership_roles to surge_app;

alter table app.support_tickets
  add constraint support_tickets_business_fkey foreign key ("businessId") references app.businesses ("id") on delete restrict;
