-- Communications: unified templated messaging (email/SMS/WhatsApp) with
-- delivery tracking, a prepaid credit ledger, curated audience segments, and
-- sending-domain/sender identity verification.
--
-- Legacy source is two structurally separate systems that only share a
-- credit pool: src/services/channel.service.ts (SMS/WhatsApp "channel
-- messages", segment-targeted) and src/services/crm.service.ts's campaign
-- methods (email "campaigns", audience-targeted), plus
-- src/services/campaign-credits.service.ts (shared credit ledger) and
-- src/services/communications.service.ts (sending-domain/sender identity -
-- confirmed orphaned in legacy: live in Settings UI, but never actually
-- consulted by either send path, which hard-code a generated address
-- instead). This migration unifies messages/templates/deliveries into one
-- model per PROPOSED_TABLE_INVENTORY.md's singular naming
-- (communication_templates/messages/deliveries, not separate
-- channel_template + campaign tables), and wires sender resolution into the
-- send path for real instead of reproducing the disconnect.
--
-- Redesigned, not ported, in several places:
--   * No audience/segment schema existed anywhere in the approved plan
--     (legacy's contacts/segments/crm_contacts_unified are explicitly
--     superseded by the parties domain, which has no grouping concept).
--     communication_audience_segments/_members below is new: a curated,
--     manually-managed membership list against app.parties - not a
--     dynamic filter/query engine, which is a materially larger and
--     differently-risky feature nothing here approves.
--   * Template provider-submission/approval (legacy's submitTemplate)
--     always threw "not implemented" for every provider in legacy - never
--     actually worked for anyone - so template status/header/button
--     fields tied to that dead workflow are dropped, not carried over.
--   * No background-job infrastructure exists yet (the jobs domain is an
--     empty shell; no QStash wiring anywhere in next/), so sends are
--     processed synchronously in the request rather than reserve-then-
--     queue-then-finalize like legacy. Credit accounting is a single
--     locked-row debit per send instead of legacy's reserve/refund pair,
--     since there's no async window for a reservation to protect.
--     Scheduled-for-later sending is not supported for the same reason
--     (no dispatcher to fire it) and scheduledAt is intentionally not a
--     column here.
--   * Delivery status is coarser than legacy's (pending/sent/failed only,
--     not delivered/opened/clicked/bounced): those finer states depend on
--     provider delivery-receipt webhooks (Termii/Twilio/Meta/Plunk), which
--     would mean extending provider-events for four more providers - out
--     of this slice's scope, flagged as a follow-up.
--   * Opt-out/suppression is new: legacy's sms_opted_out/whatsapp_opted_in
--     lived as columns on its own contacts table, which no longer exists.
--     communication_opt_outs is a communications-owned suppression list
--     instead of adding columns to the already-shipped parties domain.

insert into app.permissions ("code", "description") values
  ('communications.read', 'View communication templates, messages, deliveries, audiences, senders, and credits'),
  ('communications.manage', 'Manage communication templates, messages, audiences, senders, and credits')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('communications.read', 'communications.manage')
on conflict do nothing;

-- ============================================================================
-- Sending domains and sender identity
-- ============================================================================

create table app.communication_domains (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "domain" text not null check (length(trim("domain")) between 1 and 255),
  "status" text not null default 'pending' check ("status" in ('pending', 'verified', 'failed')),
  "dnsRecords" jsonb not null default '[]'::jsonb check (jsonb_typeof("dnsRecords") = 'array'),
  "verifiedAt" timestamptz,
  "lastVerifiedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "domain")
);

create trigger communication_domains_set_updated_at before update on app.communication_domains
  for each row execute function app.set_updated_at();

alter table app.communication_domains enable row level security;
create policy communication_domains_read on app.communication_domains for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_domains_write on app.communication_domains for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_domains_update on app.communication_domains for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_domains_delete on app.communication_domains for delete
  using (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, update, delete on app.communication_domains to scripe_app;

create table app.communication_senders (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "domainId" uuid references app.communication_domains ("id") on delete restrict,
  "name" text not null check (length(trim("name")) between 1 and 100),
  "email" text not null check (length(trim("email")) between 3 and 255),
  "isDefault" boolean not null default false,
  "isActive" boolean not null default true,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "email")
);

-- At most one default sender per business.
create unique index communication_senders_one_default_idx on app.communication_senders ("businessId") where "isDefault";

create trigger communication_senders_set_updated_at before update on app.communication_senders
  for each row execute function app.set_updated_at();

alter table app.communication_senders enable row level security;
create policy communication_senders_read on app.communication_senders for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_senders_write on app.communication_senders for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_senders_update on app.communication_senders for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_senders_delete on app.communication_senders for delete
  using (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, update, delete on app.communication_senders to scripe_app;

-- ============================================================================
-- Templates
-- ============================================================================

create table app.communication_templates (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "channel" text not null check ("channel" in ('email', 'sms', 'whatsapp')),
  "name" text not null check (length(trim("name")) between 1 and 150),
  "subject" text check ("subject" is null or length(trim("subject")) between 1 and 250),
  "body" text not null check (length(trim("body")) between 1 and 20000),
  "isActive" boolean not null default true,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  -- Only the email channel has a subject line; sms/whatsapp are body-only.
  constraint communication_templates_subject_channel_chk check (("channel" = 'email') = ("subject" is not null))
);

create index communication_templates_business_channel_idx on app.communication_templates ("businessId", "channel");

create trigger communication_templates_set_updated_at before update on app.communication_templates
  for each row execute function app.set_updated_at();

alter table app.communication_templates enable row level security;
create policy communication_templates_read on app.communication_templates for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_templates_write on app.communication_templates for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_templates_update on app.communication_templates for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_templates_delete on app.communication_templates for delete
  using (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, update, delete on app.communication_templates to scripe_app;

-- ============================================================================
-- Audience segments (new - curated membership, not dynamic filtering)
-- ============================================================================

create table app.communication_audience_segments (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "name" text not null check (length(trim("name")) between 1 and 150),
  "description" text check ("description" is null or length(trim("description")) <= 1000),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "name")
);

create trigger communication_audience_segments_set_updated_at before update on app.communication_audience_segments
  for each row execute function app.set_updated_at();

alter table app.communication_audience_segments enable row level security;
create policy communication_audience_segments_read on app.communication_audience_segments for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_audience_segments_write on app.communication_audience_segments for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_audience_segments_update on app.communication_audience_segments for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_audience_segments_delete on app.communication_audience_segments for delete
  using (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, update, delete on app.communication_audience_segments to scripe_app;

create table app.communication_audience_segment_members (
  "segmentId" uuid not null references app.communication_audience_segments ("id") on delete cascade,
  "partyId" uuid not null references app.parties ("id") on delete cascade,
  "addedAt" timestamptz not null default now(),
  primary key ("segmentId", "partyId")
);

alter table app.communication_audience_segment_members enable row level security;
create policy communication_audience_segment_members_read on app.communication_audience_segment_members for select
  using (exists (
    select 1 from app.communication_audience_segments segment
    where segment."id" = "segmentId" and app.has_business_permission(segment."businessId", 'communications.read')
  ));
create policy communication_audience_segment_members_write on app.communication_audience_segment_members for insert
  with check (exists (
    select 1 from app.communication_audience_segments segment
    where segment."id" = "segmentId" and app.has_business_permission(segment."businessId", 'communications.manage')
  ));
create policy communication_audience_segment_members_delete on app.communication_audience_segment_members for delete
  using (exists (
    select 1 from app.communication_audience_segments segment
    where segment."id" = "segmentId" and app.has_business_permission(segment."businessId", 'communications.manage')
  ));

grant select, insert, delete on app.communication_audience_segment_members to scripe_app;

-- ============================================================================
-- Opt-out / suppression (new - replaces legacy's per-contact opt-out columns
-- on a contacts table that no longer exists)
-- ============================================================================

create table app.communication_opt_outs (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "partyId" uuid not null references app.parties ("id") on delete cascade,
  "channel" text not null check ("channel" in ('email', 'sms', 'whatsapp')),
  "reason" text check ("reason" is null or length(trim("reason")) <= 500),
  "optedOutAt" timestamptz not null default now(),
  unique ("businessId", "partyId", "channel")
);

alter table app.communication_opt_outs enable row level security;
create policy communication_opt_outs_read on app.communication_opt_outs for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_opt_outs_write on app.communication_opt_outs for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_opt_outs_delete on app.communication_opt_outs for delete
  using (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, delete on app.communication_opt_outs to scripe_app;

-- ============================================================================
-- Credits: a locked stored balance (not a derived sum) plus an immutable
-- ledger, so reserve/debit can be checked-then-written atomically under a
-- single row lock within the sending transaction.
-- ============================================================================

create table app.communication_credit_accounts (
  "businessId" uuid primary key references app.businesses ("id") on delete restrict,
  "balance" bigint not null default 0 check ("balance" >= 0),
  "updatedAt" timestamptz not null default now()
);

create trigger communication_credit_accounts_set_updated_at before update on app.communication_credit_accounts
  for each row execute function app.set_updated_at();

alter table app.communication_credit_accounts enable row level security;
create policy communication_credit_accounts_read on app.communication_credit_accounts for select
  using (app.has_business_permission("businessId", 'communications.read'));
-- Balance is only ever mutated by this domain's own service code, which
-- always requires communications.manage before touching it - insert/update
-- policies still gate on it as defense in depth.
create policy communication_credit_accounts_insert on app.communication_credit_accounts for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_credit_accounts_update on app.communication_credit_accounts for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert, update on app.communication_credit_accounts to scripe_app;

create table app.communication_credit_entries (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "kind" text not null check ("kind" in ('purchase', 'debit', 'refund')),
  "credits" bigint not null check ("credits" <> 0),
  "balanceAfter" bigint not null check ("balanceAfter" >= 0),
  "referenceType" text check ("referenceType" in ('topup', 'message')),
  "referenceId" uuid,
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "createdAt" timestamptz not null default now()
);

create index communication_credit_entries_business_idx on app.communication_credit_entries ("businessId", "createdAt" desc);

create trigger communication_credit_entries_immutable before update or delete on app.communication_credit_entries
  for each row execute function app.reject_immutable_change();

alter table app.communication_credit_entries enable row level security;
create policy communication_credit_entries_read on app.communication_credit_entries for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_credit_entries_insert on app.communication_credit_entries for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));

grant select, insert on app.communication_credit_entries to scripe_app;

create table app.communication_credit_topups (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "credits" bigint not null check ("credits" > 0),
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "assetCode" text not null,
  "gateway" text not null check ("gateway" in ('paystack', 'flutterwave')),
  "providerReference" text not null unique,
  "status" text not null default 'pending' check ("status" in ('pending', 'succeeded', 'failed')),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "completedAt" timestamptz
);

create index communication_credit_topups_business_idx on app.communication_credit_topups ("businessId", "createdAt" desc);

alter table app.communication_credit_topups enable row level security;
create policy communication_credit_topups_read on app.communication_credit_topups for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_credit_topups_insert on app.communication_credit_topups for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
-- No update policy: the webhook path never has the submitter's authorized
-- business context (provider-events runs every webhook as scripe_app with an
-- anonymous principal - there is no separate scripe_worker-authenticated
-- connection anywhere in this codebase despite the role existing). Webhook
-- reconciliation goes through the security-definer function below instead,
-- the same escape hatch capture_checkout_payment_from_webhook (0029) already
-- established for this exact problem.

grant select, insert on app.communication_credit_topups to scripe_app;

-- Reconciles a Paystack/Flutterwave credit top-up from its webhook: marks
-- the topup succeeded (idempotent - only a still-pending row transitions,
-- so a duplicate delivery is a no-op) and credits the account plus its
-- ledger entry, atomically, under the function owner's RLS-bypassing
-- privileges rather than the caller's (anonymous, business-less) context.
create or replace function app.complete_communication_credit_topup(target_reference text)
returns table ("found" boolean, "alreadyCompleted" boolean, "businessId" uuid, "credits" bigint)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_topup_id uuid;
  v_business_id uuid;
  v_credits bigint;
  v_status text;
  v_balance bigint;
begin
  select topup."id", topup."businessId", topup."credits", topup."status" into v_topup_id, v_business_id, v_credits, v_status
    from app.communication_credit_topups topup where topup."providerReference" = target_reference for update;

  if not found then
    return query select false, false, null::uuid, null::bigint;
    return;
  end if;

  if v_status <> 'pending' then
    return query select true, true, v_business_id, v_credits;
    return;
  end if;

  update app.communication_credit_topups set "status" = 'succeeded', "completedAt" = now() where "id" = v_topup_id;

  insert into app.communication_credit_accounts ("businessId") values (v_business_id) on conflict do nothing;
  update app.communication_credit_accounts account set "balance" = account."balance" + v_credits where account."businessId" = v_business_id
    returning account."balance" into v_balance;

  insert into app.communication_credit_entries ("businessId", "kind", "credits", "balanceAfter", "referenceType", "referenceId")
    values (v_business_id, 'purchase', v_credits, v_balance, 'topup', v_topup_id);

  return query select true, false, v_business_id, v_credits;
end;
$$;

revoke all on function app.complete_communication_credit_topup(text) from public;
grant execute on function app.complete_communication_credit_topup(text) to scripe_app;

-- Marks a top-up failed from its webhook (payment declined/abandoned) -
-- same anonymous-caller problem, same security-definer escape hatch.
create or replace function app.fail_communication_credit_topup(target_reference text)
returns boolean
language sql volatile security definer
set search_path = app, pg_temp
as $$
  with updated as (
    update app.communication_credit_topups set "status" = 'failed'
      where "providerReference" = target_reference and "status" = 'pending'
    returning 1
  )
  select exists (select 1 from updated);
$$;

revoke all on function app.fail_communication_credit_topup(text) from public;
grant execute on function app.fail_communication_credit_topup(text) to scripe_app;

-- ============================================================================
-- Messages and deliveries
-- ============================================================================

create table app.communication_messages (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "channel" text not null check ("channel" in ('email', 'sms', 'whatsapp')),
  "name" text not null check (length(trim("name")) between 1 and 150),
  "status" text not null default 'draft' check ("status" in ('draft', 'processing', 'sent', 'partial', 'failed', 'cancelled')),
  "templateId" uuid references app.communication_templates ("id") on delete set null,
  "senderId" uuid references app.communication_senders ("id") on delete set null,
  "subject" text check ("subject" is null or length(trim("subject")) between 1 and 250),
  "body" text check ("body" is null or length(trim("body")) between 1 and 20000),
  "audienceType" text not null check ("audienceType" in ('all', 'segment')),
  "audienceSegmentId" uuid references app.communication_audience_segments ("id") on delete restrict,
  "recipientCount" integer,
  "sentCount" integer not null default 0,
  "failedCount" integer not null default 0,
  "creditsSpent" bigint not null default 0,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  -- A segment id is required for segment targeting and forbidden for "all".
  constraint communication_messages_audience_chk check (("audienceType" = 'segment') = ("audienceSegmentId" is not null)),
  -- Either an approved template or an explicit body must supply content.
  constraint communication_messages_content_chk check ("templateId" is not null or "body" is not null)
);

create index communication_messages_business_idx on app.communication_messages ("businessId", "createdAt" desc);

create trigger communication_messages_set_updated_at before update on app.communication_messages
  for each row execute function app.set_updated_at();

alter table app.communication_messages enable row level security;
create policy communication_messages_read on app.communication_messages for select
  using (app.has_business_permission("businessId", 'communications.read'));
create policy communication_messages_write on app.communication_messages for insert
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_messages_update on app.communication_messages for update
  using (app.has_business_permission("businessId", 'communications.manage'))
  with check (app.has_business_permission("businessId", 'communications.manage'));
create policy communication_messages_delete on app.communication_messages for delete
  using (app.has_business_permission("businessId", 'communications.manage') and "status" = 'draft');

grant select, insert, update, delete on app.communication_messages to scripe_app;

create table app.communication_deliveries (
  "id" uuid primary key default gen_random_uuid(),
  "messageId" uuid not null references app.communication_messages ("id") on delete cascade,
  "partyId" uuid not null references app.parties ("id") on delete restrict,
  "destination" text not null check (length(trim("destination")) between 1 and 320),
  "status" text not null default 'pending' check ("status" in ('pending', 'sent', 'failed')),
  "providerMessageId" text,
  "errorMessage" text,
  "creditCost" bigint not null default 0 check ("creditCost" >= 0),
  "sentAt" timestamptz,
  "failedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  unique ("messageId", "partyId")
);

create index communication_deliveries_message_idx on app.communication_deliveries ("messageId");

alter table app.communication_deliveries enable row level security;
create policy communication_deliveries_read on app.communication_deliveries for select
  using (exists (
    select 1 from app.communication_messages message
    where message."id" = "messageId" and app.has_business_permission(message."businessId", 'communications.read')
  ));
create policy communication_deliveries_insert on app.communication_deliveries for insert
  with check (exists (
    select 1 from app.communication_messages message
    where message."id" = "messageId" and app.has_business_permission(message."businessId", 'communications.manage')
  ));
create policy communication_deliveries_update on app.communication_deliveries for update
  using (exists (
    select 1 from app.communication_messages message
    where message."id" = "messageId" and app.has_business_permission(message."businessId", 'communications.manage')
  ))
  with check (exists (
    select 1 from app.communication_messages message
    where message."id" = "messageId" and app.has_business_permission(message."businessId", 'communications.manage')
  ));

grant select, insert, update on app.communication_deliveries to scripe_app;
