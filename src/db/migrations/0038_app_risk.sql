-- Risk: fraud signal, case investigation, and transaction holds. Ported
-- from legacy src/services/fraud-detection.service.ts (public.fraud_signals),
-- verified against the live admin console
-- (Scripe-fe/src/components/Admin/TrustSafety/FraudDashboard.tsx).
--
-- This is a platform-staff feature, not a business self-service one:
-- legacy's fraud_signals table was RLS'd service-role-only, and its only
-- consumers were admin.controller.ts routes gated by requireAdmin("support")
-- - the same authority as the platform domain's administrators, not
-- business membership permissions. Authorization here reuses
-- requirePlatformAdministrator from the platform domain rather than
-- app.has_business_permission.
--
-- Redesign vs legacy:
--   * Legacy's runChecks() (large-transaction rule evaluation) was dead
--     code - never called from any real request path, so "detection" only
--     ever happened through recordSignal() being called directly, which
--     nothing did either. This slice wires a real caller: banking's
--     requestWithdrawal now calls into this domain's recordSignal for
--     large withdrawals and checks for an active hold before proceeding -
--     legacy's original, never-activated intent, actually turned on.
--   * risk_cases and transaction_holds have no legacy implementation or
--     frontend surface (confirmed: zero matches for "investigation" or
--     "hold" anywhere in Scripe-fe), but both are explicitly named in
--     PROPOSED_TABLE_INVENTORY.md section 16 - approved schema, not
--     invented. Kept intentionally minimal: risk_cases groups signals
--     under a status/assignee/resolution note; transaction_holds only
--     covers business/user-level holds (freeze the account), not a hold on
--     a specific not-yet-created transaction, which legacy's own
--     entity_type vocabulary and the "blocks execution" framing in the
--     inventory doc both point toward anyway.
--   * risk_signals drops the businessId column entirely: legacy's table
--     never had one, and the live admin dashboard has no business filter -
--     the subject is entityType+entityId (polymorphic, unconstrained,
--     matching audit_events' targetType/targetId), not a tenant boundary.

create table app.risk_signals (
  "id" uuid primary key default gen_random_uuid(),
  "entityType" text not null check ("entityType" in ('order', 'payment', 'refund', 'transfer', 'register_shift', 'user', 'business', 'stock_adjustment')),
  "entityId" uuid not null,
  "signalType" text not null check (length(trim("signalType")) between 1 and 100),
  "description" text not null check (length(trim("description")) between 1 and 2000),
  "severity" text not null check ("severity" in ('critical', 'high', 'medium', 'low')),
  "status" text not null default 'open' check ("status" in ('open', 'investigating', 'confirmed', 'cleared')),
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "riskCaseId" uuid,
  "reviewedBy" uuid references auth.user ("id") on delete set null,
  "reviewNotes" text,
  "reviewedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index risk_signals_status_idx on app.risk_signals ("status", "createdAt" desc);
create index risk_signals_entity_idx on app.risk_signals ("entityType", "entityId");
create index risk_signals_case_idx on app.risk_signals ("riskCaseId") where "riskCaseId" is not null;

alter table app.risk_signals enable row level security;
create policy risk_signals_read on app.risk_signals for select
  using (app.is_platform_administrator());
create policy risk_signals_update on app.risk_signals for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());
-- Raised by other domains' server-side code about an event, not the
-- caller's own identity - same insert shape as admin_alerts/audit_events.
create policy risk_signals_insert on app.risk_signals for insert with check (true);

grant select, insert, update on app.risk_signals to scripe_app;

create table app.risk_cases (
  "id" uuid primary key default gen_random_uuid(),
  "title" text not null check (length(trim("title")) between 1 and 200),
  "status" text not null default 'open' check ("status" in ('open', 'investigating', 'resolved', 'dismissed')),
  "assignedTo" uuid references auth.user ("id") on delete set null,
  "resolutionNotes" text,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "resolvedAt" timestamptz
);

alter table app.risk_signals add constraint risk_signals_case_fk foreign key ("riskCaseId") references app.risk_cases ("id") on delete set null;

create index risk_cases_status_idx on app.risk_cases ("status", "createdAt" desc);

create trigger risk_cases_set_updated_at before update on app.risk_cases
  for each row execute function app.set_updated_at();

alter table app.risk_cases enable row level security;
create policy risk_cases_read on app.risk_cases for select
  using (app.is_platform_administrator());
create policy risk_cases_insert on app.risk_cases for insert
  with check (app.is_platform_administrator());
create policy risk_cases_update on app.risk_cases for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());

grant select, insert, update on app.risk_cases to scripe_app;

create table app.transaction_holds (
  "id" uuid primary key default gen_random_uuid(),
  "entityType" text not null check ("entityType" in ('business', 'user')),
  "entityId" uuid not null,
  "reason" text not null check (length(trim("reason")) between 1 and 1000),
  "status" text not null default 'active' check ("status" in ('active', 'released')),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "releasedBy" uuid references auth.user ("id") on delete set null,
  "releasedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

-- At most one active hold per entity - a second hold attempt should
-- extend/replace the existing one, not silently coexist with it.
create unique index transaction_holds_one_active_idx on app.transaction_holds ("entityType", "entityId") where "status" = 'active';

alter table app.transaction_holds enable row level security;
create policy transaction_holds_read on app.transaction_holds for select
  using (app.is_platform_administrator());
create policy transaction_holds_insert on app.transaction_holds for insert
  with check (app.is_platform_administrator());
create policy transaction_holds_update on app.transaction_holds for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());

grant select, insert, update on app.transaction_holds to scripe_app;

-- Lets any business-scoped caller (e.g. banking's withdrawal gate) check for
-- an active hold without needing direct table access, the same shape as
-- has_business_permission - a security-definer predicate rather than
-- widening transaction_holds' own RLS to every caller.
create or replace function app.has_active_transaction_hold(target_entity_type text, target_entity_id uuid) returns boolean
language sql stable security definer
set search_path = app, pg_temp
as $$
  select exists (
    select 1 from app.transaction_holds
    where "entityType" = target_entity_type and "entityId" = target_entity_id and "status" = 'active'
  );
$$;

revoke all on function app.has_active_transaction_hold(text, uuid) from public;
grant execute on function app.has_active_transaction_hold(text, uuid) to scripe_app;
