-- 0007_app_helpdesk_tickets.sql
-- Wave-A slice 2 (rules.md §F.3 baseline schemas): helpdesk tickets + replies.
-- Mirrors the legacy support_tickets product columns (category/priority/status
-- enums from evidence, rules.md §C) translated to new conventions, reusing
-- app.set_updated_at() (0006) and app.current_user_id() RLS helper.
-- Runs as the scripe_migrator.

create table app.support_tickets (
  "id"           uuid        primary key default gen_random_uuid(),
  "subject"      text        not null,
  "description"  text        not null,
  "category"     text        not null default 'other'
                 check (category in ('billing', 'technical', 'feature_request', 'account', 'other')),
  "priority"     text        not null default 'medium'
                 check (priority in ('low', 'medium', 'high', 'urgent')),
  "status"       text        not null default 'open'
                 check (status in ('open', 'in_progress', 'waiting_on_user', 'resolved', 'closed')),
  "businessId"   uuid,
  "submitterId"  uuid        references auth.user ("id") on delete set null,
  "submitterEmail" text,
  "assignedTo"   uuid        references auth.user ("id") on delete set null,
  "resolvedAt"   timestamptz,
  "createdAt"    timestamptz not null default now(),
  "updatedAt"    timestamptz not null default now()
);

create index support_tickets_status_idx on app.support_tickets ("status");
create index support_tickets_submitter_idx on app.support_tickets ("submitterId");
create index support_tickets_business_idx on app.support_tickets ("businessId");

create table app.support_ticket_replies (
  "id"         uuid        primary key default gen_random_uuid(),
  "ticketId"   uuid        not null references app.support_tickets ("id") on delete cascade,
  "body"       text        not null,
  "authorId"   uuid        references auth.user ("id") on delete set null,
  "authorEmail" text,
  "isInternal" boolean     not null default false,
  "createdAt"  timestamptz not null default now()
);

create index support_ticket_replies_ticket_idx on app.support_ticket_replies ("ticketId");

comment on table app.support_tickets is
  'Helpdesk tickets. businessId FK lands in Wave-B (businesses domain).';

create trigger support_tickets_set_updated_at
  before update on app.support_tickets
  for each row execute function app.set_updated_at();

alter table app.support_tickets enable row level security;
alter table app.support_ticket_replies enable row level security;

-- Submitter owns their ticket + its replies. scripe_worker (agent) may read a
-- ticket via the scripe_app-adjacent path granted below.
create policy support_tickets_select_submitter on app.support_tickets
  for select
  using (app.current_user_id() = "submitterId"::text);

create policy support_tickets_insert_submitter on app.support_tickets
  for insert
  with check (app.current_user_id() = "submitterId"::text);

create policy support_tickets_update_submitter on app.support_tickets
  for update
  using (app.current_user_id() = "submitterId"::text);

create policy support_ticket_replies_select_submitter on app.support_ticket_replies
  for select
  using (app.current_user_id() = "authorId"::text);

create policy support_ticket_replies_insert_submitter on app.support_ticket_replies
  for insert
  with check (app.current_user_id() = "authorId"::text);

grant select on app.support_tickets, app.support_ticket_replies to scripe_worker;
grant select, insert, update on app.support_tickets, app.support_ticket_replies to scripe_app;
