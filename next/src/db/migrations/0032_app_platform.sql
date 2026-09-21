-- Platform: internal Surge-staff administration, operational alerts, and
-- platform-wide announcements. Ported from legacy admin_users/admin_alerts/
-- system_announcements (src/services/admin.service.ts,
-- src/services/admin-alerts.service.ts,
-- src/services/system-announcements.service.ts), verified against the live
-- admin console (Surge-fe/src/components/Admin/{AdminUsers,Alerts,
-- Announcements}) rather than the legacy backend alone.
--
-- Redesign vs legacy:
--   * platform_administrators is authorized independently of any business
--     role or membership - never inferred from app.business_memberships.
--     Bootstrapping the first administrator is an out-of-band operator step
--     (see db/bootstrap-platform-admin.ts), not an API endpoint - there is no
--     legitimate self-service path to becoming platform staff.
--   * admin_alerts.severity gains high/medium/low alongside legacy's
--     info/warning/critical: the frontend alert bell has rendered five
--     severities since before this rewrite, and frontend behavior is
--     authoritative over the legacy backend's narrower enum for the actual
--     product contract.
--   * system_announcements gains "ctaLabel"/"ctaUrl" and renames
--     "expiresAt" to "endsAt" - fields the admin console's create/edit form
--     already sends that the legacy table never had.
--   * Legacy's admin_users.permissions JSONB is retained for forward
--     compatibility with updateAdmin's payload shape, but no route in this
--     slice checks it: every legacy route gating admins/alerts/announcements
--     used requireAdmin(minRole) - plain role-hierarchy comparison - not
--     requireAdminPermission. Granular permission checks were never actually
--     wired to these endpoints.
--   * admin_audit_logs is not re-created here: it merges into the existing
--     app.audit_events table (this domain's service calls
--     auditRepository.log() directly, businessId null, the same pattern
--     authorization already uses).
--
-- Explicitly out of scope for this slice (see domain README / rewrite
-- report): admin_notes (no frontend usage found), impersonateUser
-- (security-sensitive, never finished in legacy, doesn't fit this domain's
-- scope), and system_announcements.getActiveForPlan (no live frontend
-- consumer, depends on the not-yet-built subscriptions domain for plan
-- resolution).

create table app.platform_administrators (
  "id" uuid primary key default gen_random_uuid(),
  "userId" uuid not null unique references auth.user ("id") on delete restrict,
  "role" text not null check ("role" in ('super_admin', 'finance', 'support', 'moderator', 'viewer')),
  "name" text not null check (length(trim("name")) between 1 and 200),
  "email" text not null unique check (length(trim("email")) between 3 and 320),
  "isActive" boolean not null default true,
  "permissions" jsonb not null default '[]'::jsonb check (jsonb_typeof("permissions") = 'array'),
  "lastLoginAt" timestamptz,
  "createdBy" uuid references app.platform_administrators ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create index platform_administrators_active_idx on app.platform_administrators ("isActive");

create trigger platform_administrators_set_updated_at before update on app.platform_administrators
  for each row execute function app.set_updated_at();

-- Defense-in-depth predicate for RLS below. Never inferred from a business
-- role: reads only this table, keyed off the transaction-local user id.
-- security definer + a locked search_path is load-bearing, not decorative:
-- platform_administrators' own select policy calls this function, so
-- without security definer (which runs as the function owner - the table
-- owner, who bypasses RLS by default) the lookup below would re-trigger the
-- same policy on itself and recurse until Postgres hits its stack depth
-- limit.
create or replace function app.is_platform_administrator() returns boolean
language sql stable security definer
set search_path = app, pg_catalog
as $$
  select exists (
    select 1 from app.platform_administrators
    where "userId"::text = app.current_user_id() and "isActive"
  );
$$;

revoke all on function app.is_platform_administrator() from public;
grant execute on function app.is_platform_administrator() to surge_app;

alter table app.platform_administrators enable row level security;

create policy platform_administrators_select on app.platform_administrators for select
  using (app.is_platform_administrator());
create policy platform_administrators_insert on app.platform_administrators for insert
  with check (app.is_platform_administrator());
create policy platform_administrators_update on app.platform_administrators for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());

grant select, insert, update on app.platform_administrators to surge_app;

create table app.admin_alerts (
  "id" uuid primary key default gen_random_uuid(),
  "type" text not null check (length(trim("type")) between 1 and 100),
  "severity" text not null check ("severity" in ('critical', 'high', 'medium', 'low', 'info')),
  "title" text not null check (length(trim("title")) between 1 and 200),
  "message" text not null check (length(trim("message")) between 1 and 2000),
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "isRead" boolean not null default false,
  "readAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index admin_alerts_unread_idx on app.admin_alerts ("createdAt" desc) where not "isRead";
create index admin_alerts_created_idx on app.admin_alerts ("createdAt" desc);

alter table app.admin_alerts enable row level security;

create policy admin_alerts_select on app.admin_alerts for select
  using (app.is_platform_administrator());
create policy admin_alerts_update on app.admin_alerts for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());
-- Raised by other domains' server-side code about a platform-level event,
-- not the caller's own identity - same insert shape as audit_events/
-- notifications.
create policy admin_alerts_insert on app.admin_alerts for insert with check (true);

grant select, insert, update on app.admin_alerts to surge_app;

create table app.system_announcements (
  "id" uuid primary key default gen_random_uuid(),
  "title" text not null check (length(trim("title")) between 1 and 200),
  "body" text not null check (length(trim("body")) between 1 and 5000),
  "type" text not null check ("type" in ('info', 'warning', 'feature', 'maintenance', 'changelog')),
  "audience" text not null check ("audience" in ('all', 'pro', 'plus', 'starter', 'paid')),
  "ctaLabel" text check ("ctaLabel" is null or length(trim("ctaLabel")) between 1 and 80),
  "ctaUrl" text check ("ctaUrl" is null or length(trim("ctaUrl")) between 1 and 2048),
  "isActive" boolean not null default true,
  "startsAt" timestamptz,
  "endsAt" timestamptz,
  "createdBy" uuid references app.platform_administrators ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  constraint system_announcements_window_chk check ("startsAt" is null or "endsAt" is null or "startsAt" <= "endsAt"),
  constraint system_announcements_cta_pair_chk check (("ctaLabel" is null) = ("ctaUrl" is null))
);

create index system_announcements_active_idx on app.system_announcements ("isActive", "createdAt" desc);

create trigger system_announcements_set_updated_at before update on app.system_announcements
  for each row execute function app.set_updated_at();

alter table app.system_announcements enable row level security;

create policy system_announcements_select on app.system_announcements for select
  using (app.is_platform_administrator());
create policy system_announcements_insert on app.system_announcements for insert
  with check (app.is_platform_administrator());
create policy system_announcements_update on app.system_announcements for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());
create policy system_announcements_delete on app.system_announcements for delete
  using (app.is_platform_administrator());

grant select, insert, update, delete on app.system_announcements to surge_app;
