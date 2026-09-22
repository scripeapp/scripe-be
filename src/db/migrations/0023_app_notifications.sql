-- Notifications: per-user notification feed with read/archive state, and a
-- flexible per-user-per-type-per-channel preference override. No fixed
-- registry of notification types exists yet — "type" is a free-text key
-- that future domains define as they wire in (e.g. 'team.invited',
-- 'order.placed'), not invented here. This slice ships the generic
-- capability only: nothing in this codebase creates a notification yet,
-- and legacy's own "notifications" code was entirely social/publication
-- email triggers (excluded scope) plus a generic email sender already
-- rebuilt as shared/email.ts.

create table app.notification_preferences (
  "userId" uuid not null references auth.user ("id") on delete cascade,
  "type" text not null check (length(trim("type")) between 1 and 100),
  "channel" text not null check ("channel" in ('email', 'sms', 'push', 'in_app')),
  "enabled" boolean not null default true,
  "updatedAt" timestamptz not null default now(),
  primary key ("userId", "type", "channel")
);

create trigger notification_preferences_set_updated_at before update on app.notification_preferences
  for each row execute function app.set_updated_at();

alter table app.notification_preferences enable row level security;

create policy notification_preferences_select_own on app.notification_preferences for select
  using (app.current_user_id() = "userId"::text);
create policy notification_preferences_insert_own on app.notification_preferences for insert
  with check (app.current_user_id() = "userId"::text);
create policy notification_preferences_update_own on app.notification_preferences for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);

create table app.notifications (
  "id" uuid primary key default gen_random_uuid(),
  "userId" uuid not null references auth.user ("id") on delete cascade,
  "businessId" uuid references app.businesses ("id") on delete cascade,
  "type" text not null check (length(trim("type")) between 1 and 100),
  "title" text not null check (length(trim("title")) between 1 and 200),
  "body" text not null default '',
  "data" jsonb not null default '{}'::jsonb check (jsonb_typeof("data") = 'object'),
  "readAt" timestamptz,
  "archivedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index notifications_user_idx on app.notifications ("userId", "archivedAt", "createdAt" desc);
create index notifications_user_unread_idx on app.notifications ("userId") where "readAt" is null and "archivedAt" is null;

alter table app.notifications enable row level security;

create policy notifications_select_own on app.notifications for select
  using (app.current_user_id() = "userId"::text);
create policy notifications_update_own on app.notifications for update
  using (app.current_user_id() = "userId"::text)
  with check (app.current_user_id() = "userId"::text);
-- A notification is created about a user by other parts of the system (a
-- team invitation, an order event) rather than by the recipient themselves,
-- so insert is not restricted to current_user_id() the way select/update
-- are. No route in this slice exposes creation to any client — only
-- future server-side domain code (via createNotification in the
-- repository) can reach this insert.
create policy notifications_insert_system on app.notifications for insert
  with check (true);

grant select, insert, update on app.notification_preferences, app.notifications to surge_app;
