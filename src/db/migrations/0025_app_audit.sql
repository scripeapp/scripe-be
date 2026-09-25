-- Audit: an append-only log of privileged and business-mutating actions.
-- Ported from legacy audit.service.ts's log() primitive, which is generic,
-- real infrastructure (not tied to any excluded feature) and was already
-- referenced by the authorization domain's business logic before this
-- table existed. Redesign: legacy made log() fire-and-forget/non-throwing
-- because Supabase calls were separate REST requests outside any shared
-- transaction ("audit logging should not break business logic"). Here the
-- insert runs inside the same Postgres transaction as the action it
-- describes, so a real failure surfaces rather than being silently
-- swallowed — consistent with how every other side effect in this backend
-- (receipts, redemptions, stock movements) is written transactionally.

insert into app.permissions ("code", "description") values
  ('audit.read', 'View a business''s audit log')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" = 'audit.read'
on conflict do nothing;

create table app.audit_events (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid references app.businesses ("id") on delete restrict,
  "actorUserId" uuid references auth.user ("id") on delete restrict,
  "action" text not null check (length(trim("action")) between 1 and 100),
  "targetType" text,
  "targetId" text,
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "ipAddress" text,
  "userAgent" text,
  "requestId" text,
  "createdAt" timestamptz not null default now()
);

create index audit_events_business_idx on app.audit_events ("businessId", "createdAt" desc) where "businessId" is not null;
create index audit_events_action_idx on app.audit_events ("businessId", "action", "createdAt" desc) where "businessId" is not null;

-- Reuses the generic immutability guard already defined in 0009 rather than
-- redefining it.
create trigger audit_events_immutable before update or delete on app.audit_events
  for each row execute function app.reject_immutable_change();

alter table app.audit_events enable row level security;

create policy audit_events_read on app.audit_events for select
  using ("businessId" is not null and app.has_business_permission("businessId", 'audit.read'));
-- Events are recorded by other domains' server-side code about an actor and
-- target that are data, not the caller's own identity, so insert is not
-- restricted to current_user_id() — the same shape as notifications.
create policy audit_events_insert on app.audit_events for insert with check (true);

grant select, insert on app.audit_events to scripe_app;
