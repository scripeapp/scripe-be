-- Subscriptions: Surge's own SaaS billing of its merchant customers (a
-- business subscribing to Surge's plus/pro plan) - not a merchant's own
-- customer-facing product subscriptions (that's src/services/subscription.
-- service.ts, legacy's store_subscriptions/membership_content, which maps
-- to the explicitly-excluded digital-product-entitlements area and is not
-- touched here). Ported from src/services/business-subscription.service.ts
-- (550 lines) and src/services/plan-limits.service.ts (365 lines),
-- verified against the live upgrade/billing UI (Surge-fe
-- PlanAndBillings.tsx, ProUpgradeContext.tsx, ProFeatureGate.tsx - wired
-- into nearly every dashboard feature area).
--
-- Redesigned, not ported, in several places:
--   * Legacy stored subscription state as mutable columns directly on
--     businesses, with no history and no local invoice table
--     (getInvoices fetched live from Paystack every call). This follows
--     PROPOSED_TABLE_INVENTORY.md's real 6-table split instead: a
--     business_subscriptions row per subscription lifecycle (so
--     cancel-then-resubscribe keeps history, not just the current state),
--     real subscription_invoices persisted locally as they're created/paid/
--     failed, and a subscription_payment_attempts log distinct from the
--     invoice itself.
--   * plan_limits' free-form JSONB limits/features becomes normalized
--     platform_plan_entitlements rows (one per plan+key) - real
--     queryability ("which plans have custom_roles") instead of opaque
--     blobs, while staying just as open-ended (new entitlement keys don't
--     need a schema change).
--   * Dunning is real, not aspirational: legacy's invoice.payment_failed
--     handler set status=past_due with a bare "TODO: Send notification
--     email to business owner" - never implemented, and the only actual
--     enforcement was one cron sweep
--     (businessSubscriptionExpiryJob -> downgradeToStarter) with no
--     reminders in between. subscription_dunning_events plus a recurring
--     jobs-domain sweep (subscriptions.dunning_check) turns this on for
--     real: reminder emails via shared/email.ts (Surge notifying a
--     merchant about its own Surge bill - not the communications domain,
--     which is a business's outbound messaging to its own customers, a
--     different audience) during a grace period, then an actual downgrade
--     if it lapses. This is the reason subscriptions came after jobs, not
--     before it - legacy's dunning cron is exactly the "future worker-role
--     job" this needed.
--
-- Only "plan_limits.canCreate" enforcement actually wired into a real
-- caller in this slice: authorization's inviteMembers, gating the
-- team_members entitlement - the one legacy resource type with a real,
-- already-built next/ target and no reliance on an excluded/unbuilt
-- domain (crm_contacts, segments, publications, website_pages, forms all
-- have no next/ home yet). The rest of the entitlement catalog is real,
-- seeded, and queryable via hasFeature/checkLimit for domains that build
-- those resources later - not invented enforcement against nothing.

insert into app.permissions ("code", "description") values
  ('subscription.read', 'View a business''s Surge subscription, usage, and invoices'),
  ('subscription.manage', 'Change or cancel a business''s Surge subscription')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('subscription.read', 'subscription.manage')
on conflict do nothing;

create table app.platform_plans (
  "code" text primary key check ("code" in ('starter', 'plus', 'pro')),
  "name" text not null,
  "priceMonthlyMinor" bigint not null default 0 check ("priceMonthlyMinor" >= 0),
  "assetCode" text not null default 'NGN',
  "paystackPlanCode" text unique,
  "isActive" boolean not null default true,
  "sortOrder" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create trigger platform_plans_set_updated_at before update on app.platform_plans
  for each row execute function app.set_updated_at();

alter table app.platform_plans enable row level security;
-- Plan catalog is read by every authenticated caller (pricing/upgrade UI),
-- not just platform admins or business members - there is no tenant or
-- admin boundary on "what plans exist".
create policy platform_plans_read on app.platform_plans for select using (true);
create policy platform_plans_write on app.platform_plans for all
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());

grant select, insert, update on app.platform_plans to surge_app;

create table app.platform_plan_entitlements (
  "id" uuid primary key default gen_random_uuid(),
  "planCode" text not null references app.platform_plans ("code") on delete cascade,
  "key" text not null check (length(trim("key")) between 1 and 100),
  "kind" text not null check ("kind" in ('limit', 'feature')),
  "limitValue" bigint check ("limitValue" is null or "limitValue" >= 0),
  "featureEnabled" boolean,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("planCode", "key"),
  constraint platform_plan_entitlements_kind_chk check (
    ("kind" = 'limit' and "featureEnabled" is null)
    or ("kind" = 'feature' and "featureEnabled" is not null and "limitValue" is null)
  )
);

create index platform_plan_entitlements_plan_idx on app.platform_plan_entitlements ("planCode");

create trigger platform_plan_entitlements_set_updated_at before update on app.platform_plan_entitlements
  for each row execute function app.set_updated_at();

alter table app.platform_plan_entitlements enable row level security;
create policy platform_plan_entitlements_read on app.platform_plan_entitlements for select using (true);
create policy platform_plan_entitlements_write on app.platform_plan_entitlements for all
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());

grant select, insert, update on app.platform_plan_entitlements to surge_app;

create table app.business_subscriptions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "planCode" text not null references app.platform_plans ("code"),
  "status" text not null default 'trialing' check ("status" in ('trialing', 'active', 'past_due', 'cancelled', 'expired')),
  "providerSubscriptionCode" text unique,
  "providerCustomerCode" text,
  "providerEmailToken" text,
  "startedAt" timestamptz not null default now(),
  "currentPeriodEndsAt" timestamptz,
  "cancelledAt" timestamptz,
  "endedAt" timestamptz,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- At most one non-terminal (trialing/active/past_due) subscription per
-- business - cancelled/expired rows accumulate as real history, matching
-- PROPOSED_TABLE_INVENTORY.md's "historical" status intent, unlike legacy's
-- single mutable row.
create unique index business_subscriptions_one_current_idx on app.business_subscriptions ("businessId")
  where "status" in ('trialing', 'active', 'past_due');
create index business_subscriptions_business_idx on app.business_subscriptions ("businessId", "createdAt" desc);

create trigger business_subscriptions_set_updated_at before update on app.business_subscriptions
  for each row execute function app.set_updated_at();

alter table app.business_subscriptions enable row level security;
create policy business_subscriptions_read on app.business_subscriptions for select
  using (app.has_business_permission("businessId", 'subscription.read'));
create policy business_subscriptions_write on app.business_subscriptions for all
  using (app.has_business_permission("businessId", 'subscription.manage'))
  with check (app.has_business_permission("businessId", 'subscription.manage'));

grant select, insert, update on app.business_subscriptions to surge_app;

create table app.subscription_invoices (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "subscriptionId" uuid not null references app.business_subscriptions ("id") on delete restrict,
  "amountMinor" bigint not null check ("amountMinor" >= 0),
  "assetCode" text not null default 'NGN',
  "status" text not null default 'pending' check ("status" in ('pending', 'paid', 'failed')),
  "periodStart" timestamptz,
  "periodEnd" timestamptz,
  "providerReference" text unique,
  "paidAt" timestamptz,
  "createdAt" timestamptz not null default now()
);

create index subscription_invoices_business_idx on app.subscription_invoices ("businessId", "createdAt" desc);
create index subscription_invoices_subscription_idx on app.subscription_invoices ("subscriptionId", "createdAt" desc);

alter table app.subscription_invoices enable row level security;
create policy subscription_invoices_read on app.subscription_invoices for select
  using (app.has_business_permission("businessId", 'subscription.read'));
create policy subscription_invoices_insert on app.subscription_invoices for insert
  with check (app.has_business_permission("businessId", 'subscription.manage'));

grant select, insert, update on app.subscription_invoices to surge_app;

create table app.subscription_payment_attempts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "invoiceId" uuid not null references app.subscription_invoices ("id") on delete restrict,
  "status" text not null check ("status" in ('initiated', 'succeeded', 'failed')),
  "providerReference" text,
  "failureReason" text,
  "createdAt" timestamptz not null default now()
);

create index subscription_payment_attempts_invoice_idx on app.subscription_payment_attempts ("invoiceId", "createdAt" desc);

alter table app.subscription_payment_attempts enable row level security;
create policy subscription_payment_attempts_read on app.subscription_payment_attempts for select
  using (app.has_business_permission("businessId", 'subscription.read'));
create policy subscription_payment_attempts_insert on app.subscription_payment_attempts for insert with check (true);

grant select, insert on app.subscription_payment_attempts to surge_app;

create table app.subscription_dunning_events (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "subscriptionId" uuid not null references app.business_subscriptions ("id") on delete restrict,
  "kind" text not null check ("kind" in ('payment_failed', 'reminder_sent', 'grace_period_expired', 'recovered')),
  "metadata" jsonb not null default '{}'::jsonb check (jsonb_typeof("metadata") = 'object'),
  "createdAt" timestamptz not null default now()
);

create index subscription_dunning_events_subscription_idx on app.subscription_dunning_events ("subscriptionId", "createdAt" desc);

create trigger subscription_dunning_events_immutable before update or delete on app.subscription_dunning_events
  for each row execute function app.reject_immutable_change();

alter table app.subscription_dunning_events enable row level security;
create policy subscription_dunning_events_read on app.subscription_dunning_events for select
  using (app.has_business_permission("businessId", 'subscription.read'));
create policy subscription_dunning_events_insert on app.subscription_dunning_events for insert with check (true);

grant select, insert on app.subscription_dunning_events to surge_app;

-- Seed the plan catalog and entitlements - real values ported from legacy's
-- plan_limits table (20260115_add_business_subscriptions.sql), rebranded
-- to Scripe. Every legacy limit/feature key is seeded (queryable),
-- even the ones nothing enforces yet (see this file's header comment).
insert into app.platform_plans ("code", "name", "priceMonthlyMinor", "paystackPlanCode", "sortOrder") values
  ('starter', 'Starter', 0, null, 0),
  ('plus', 'Plus', 400000, 'surge-plus', 1),
  ('pro', 'Pro', 750000, 'surge-pro', 2);

insert into app.platform_plan_entitlements ("planCode", "key", "kind", "limitValue") values
  ('starter', 'team_members', 'limit', 1),
  ('starter', 'products', 'limit', 10),
  ('starter', 'crm_contacts', 'limit', 100),
  ('starter', 'segments', 'limit', 0),
  ('starter', 'campaigns_per_month', 'limit', 0),
  ('starter', 'website_pages', 'limit', 1),
  ('starter', 'publications', 'limit', 1),
  ('plus', 'team_members', 'limit', 3),
  ('plus', 'products', 'limit', 20),
  ('plus', 'crm_contacts', 'limit', 1000),
  ('plus', 'segments', 'limit', 3),
  ('plus', 'campaigns_per_month', 'limit', 5),
  ('plus', 'website_pages', 'limit', 3),
  ('plus', 'publications', 'limit', 2),
  ('pro', 'team_members', 'limit', 7),
  ('pro', 'crm_contacts', 'limit', 10000),
  ('pro', 'publications', 'limit', 3)
  -- pro's products/segments/campaigns_per_month/website_pages are
  -- "unlimited" in legacy - represented here by the absence of a row
  -- (checkLimit treats a missing row as unlimited, never as zero).
on conflict ("planCode", "key") do nothing;

insert into app.platform_plan_entitlements ("planCode", "key", "kind", "featureEnabled") values
  ('starter', 'custom_roles', 'feature', false),
  ('starter', 'custom_domain', 'feature', false),
  ('starter', 'advanced_analytics', 'feature', false),
  ('starter', 'ai_assistant', 'feature', false),
  ('starter', 'priority_support', 'feature', false),
  ('plus', 'custom_roles', 'feature', false),
  ('plus', 'custom_domain', 'feature', false),
  ('plus', 'advanced_analytics', 'feature', false),
  ('plus', 'ai_assistant', 'feature', true),
  ('plus', 'priority_support', 'feature', false),
  ('pro', 'custom_roles', 'feature', true),
  ('pro', 'custom_domain', 'feature', true),
  ('pro', 'advanced_analytics', 'feature', true),
  ('pro', 'ai_assistant', 'feature', true),
  ('pro', 'priority_support', 'feature', true)
on conflict ("planCode", "key") do nothing;

-- Resolves a business's current entitlement for a key, falling back to the
-- starter plan's row when the business has no active subscription at all
-- (the implicit free tier) and treating a missing limit row as unlimited
-- (matching legacy's "unlimited" sentinel, now expressed as row absence
-- rather than a magic string). security definer: called from arbitrary
-- business-scoped domains (e.g. authorization's inviteMembers) that have
-- no reason to also need direct grants on platform_plan_entitlements
-- beyond the already-public read policy - kept consistent with this
-- migration's other cross-cutting helpers.
create or replace function app.get_business_entitlement(p_business_id uuid, p_key text)
returns table ("kind" text, "limitValue" bigint, "featureEnabled" boolean)
language plpgsql stable security definer
set search_path = app, pg_temp
as $$
declare
  v_plan_code text;
begin
  select subscription."planCode" into v_plan_code
    from app.business_subscriptions subscription
    where subscription."businessId" = p_business_id and subscription."status" in ('trialing', 'active', 'past_due')
    limit 1;

  if v_plan_code is null then
    v_plan_code := 'starter';
  end if;

  return query
    select entitlement."kind", entitlement."limitValue", entitlement."featureEnabled"
    from app.platform_plan_entitlements entitlement
    where entitlement."planCode" = v_plan_code and entitlement."key" = p_key;
end;
$$;

revoke all on function app.get_business_entitlement(uuid, text) from public;
grant execute on function app.get_business_entitlement(uuid, text) to surge_app;

-- ============================================================================
-- Webhook-driven state transitions. Every one of these is called from the
-- provider-events domain, which runs webhooks as an anonymous principal (no
-- caller business context) - the same escape hatch every other webhook path
-- in this codebase already uses, since business_subscriptions/
-- subscription_invoices' own RLS requires subscription.manage.
-- ============================================================================

-- Handles both the very first activation (subscription.create) and a
-- reactivation (subscription.enable after a past_due/cancelled period) -
-- upserts the business's one current (non-terminal) subscription row and
-- records the paid invoice/attempt for that charge.
create or replace function app.activate_business_subscription(
  p_business_id uuid, p_plan_code text, p_subscription_code text, p_customer_code text,
  p_email_token text, p_period_end timestamptz, p_amount_minor bigint, p_provider_reference text
)
returns uuid
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_subscription_id uuid;
  v_invoice_id uuid;
begin
  select subscription."id" into v_subscription_id
    from app.business_subscriptions subscription
    where subscription."businessId" = p_business_id and subscription."status" in ('trialing', 'active', 'past_due')
    for update;

  if v_subscription_id is null then
    insert into app.business_subscriptions (
      "businessId", "planCode", "status", "providerSubscriptionCode", "providerCustomerCode", "providerEmailToken", "currentPeriodEndsAt"
    ) values (
      p_business_id, p_plan_code, 'active', p_subscription_code, p_customer_code, p_email_token, p_period_end
    ) returning "id" into v_subscription_id;
  else
    update app.business_subscriptions set
      "planCode" = p_plan_code, "status" = 'active', "providerSubscriptionCode" = coalesce(p_subscription_code, "providerSubscriptionCode"),
      "providerCustomerCode" = coalesce(p_customer_code, "providerCustomerCode"), "providerEmailToken" = coalesce(p_email_token, "providerEmailToken"),
      "currentPeriodEndsAt" = coalesce(p_period_end, "currentPeriodEndsAt")
      where "id" = v_subscription_id;
  end if;

  insert into app.subscription_invoices ("businessId", "subscriptionId", "amountMinor", "status", "periodStart", "periodEnd", "providerReference", "paidAt")
    values (p_business_id, v_subscription_id, coalesce(p_amount_minor, 0), 'paid', now(), p_period_end, p_provider_reference, now())
    on conflict ("providerReference") do nothing
    returning "id" into v_invoice_id;

  if v_invoice_id is not null then
    insert into app.subscription_payment_attempts ("businessId", "invoiceId", "status", "providerReference")
      values (p_business_id, v_invoice_id, 'succeeded', p_provider_reference);
  end if;

  return v_subscription_id;
end;
$$;

revoke all on function app.activate_business_subscription(uuid, text, text, text, text, timestamptz, bigint, text) from public;
grant execute on function app.activate_business_subscription(uuid, text, text, text, text, timestamptz, bigint, text) to surge_app;

-- A recurring (non-first) successful charge on an existing subscription,
-- matched by Paystack's subscription_code rather than businessId (the
-- event carries the code; matching legacy's own correlation key for this
-- specific event).
create or replace function app.record_recurring_subscription_payment(
  p_subscription_code text, p_amount_minor bigint, p_period_end timestamptz, p_provider_reference text
)
returns boolean
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_subscription_id uuid;
  v_business_id uuid;
  v_previous_status text;
  v_invoice_id uuid;
begin
  select subscription."id", subscription."businessId", subscription."status" into v_subscription_id, v_business_id, v_previous_status
    from app.business_subscriptions subscription where subscription."providerSubscriptionCode" = p_subscription_code for update;

  if v_subscription_id is null then
    return false;
  end if;

  update app.business_subscriptions set "status" = 'active', "currentPeriodEndsAt" = coalesce(p_period_end, "currentPeriodEndsAt")
    where "id" = v_subscription_id;

  insert into app.subscription_invoices ("businessId", "subscriptionId", "amountMinor", "status", "periodStart", "periodEnd", "providerReference", "paidAt")
    values (v_business_id, v_subscription_id, coalesce(p_amount_minor, 0), 'paid', now(), p_period_end, p_provider_reference, now())
    on conflict ("providerReference") do nothing
    returning "id" into v_invoice_id;

  if v_invoice_id is not null then
    insert into app.subscription_payment_attempts ("businessId", "invoiceId", "status", "providerReference")
      values (v_business_id, v_invoice_id, 'succeeded', p_provider_reference);
    -- Only a genuine recovery (this payment cleared a past_due state) is
    -- dunning-worthy history - a routine on-time renewal is not.
    if v_previous_status = 'past_due' then
      insert into app.subscription_dunning_events ("businessId", "subscriptionId", "kind")
        values (v_business_id, v_subscription_id, 'recovered');
    end if;
  end if;

  return true;
end;
$$;

revoke all on function app.record_recurring_subscription_payment(text, bigint, timestamptz, text) from public;
grant execute on function app.record_recurring_subscription_payment(text, bigint, timestamptz, text) to surge_app;

-- subscription.enable / subscription.disable / subscription.not_renew -
-- a plain status transition on the business's current subscription, no
-- invoice involved.
create or replace function app.set_business_subscription_status(p_business_id uuid, p_status text, p_period_end timestamptz)
returns boolean
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_subscription_id uuid;
begin
  select subscription."id" into v_subscription_id
    from app.business_subscriptions subscription
    where subscription."businessId" = p_business_id and subscription."status" in ('trialing', 'active', 'past_due')
    for update;

  if v_subscription_id is null then
    return false;
  end if;

  update app.business_subscriptions set
    "status" = p_status,
    "currentPeriodEndsAt" = coalesce(p_period_end, "currentPeriodEndsAt"),
    "cancelledAt" = case when p_status in ('cancelled', 'expired') then coalesce("cancelledAt", now()) else "cancelledAt" end,
    "endedAt" = case when p_status = 'expired' then now() else "endedAt" end
    where "id" = v_subscription_id;

  return true;
end;
$$;

revoke all on function app.set_business_subscription_status(uuid, text, timestamptz) from public;
grant execute on function app.set_business_subscription_status(uuid, text, timestamptz) to surge_app;

-- invoice.payment_failed - marks the subscription past_due and records both
-- the failed invoice/attempt and the dunning event the jobs-domain sweep
-- (subscriptions.dunning_check) reacts to.
create or replace function app.record_subscription_payment_failure(p_business_id uuid, p_amount_minor bigint, p_provider_reference text)
returns uuid
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_subscription_id uuid;
  v_invoice_id uuid;
begin
  select subscription."id" into v_subscription_id
    from app.business_subscriptions subscription
    where subscription."businessId" = p_business_id and subscription."status" in ('trialing', 'active', 'past_due')
    for update;

  if v_subscription_id is null then
    return null;
  end if;

  update app.business_subscriptions set "status" = 'past_due' where "id" = v_subscription_id;

  insert into app.subscription_invoices ("businessId", "subscriptionId", "amountMinor", "status", "providerReference")
    values (p_business_id, v_subscription_id, coalesce(p_amount_minor, 0), 'failed', p_provider_reference)
    on conflict ("providerReference") do nothing
    returning "id" into v_invoice_id;

  if v_invoice_id is not null then
    insert into app.subscription_payment_attempts ("businessId", "invoiceId", "status", "providerReference", "failureReason")
      values (p_business_id, v_invoice_id, 'failed', p_provider_reference, 'Recurring charge failed');
  end if;

  insert into app.subscription_dunning_events ("businessId", "subscriptionId", "kind")
    values (p_business_id, v_subscription_id, 'payment_failed');

  return v_subscription_id;
end;
$$;

revoke all on function app.record_subscription_payment_failure(uuid, bigint, text) from public;
grant execute on function app.record_subscription_payment_failure(uuid, bigint, text) to surge_app;

-- ============================================================================
-- Dunning sweep (jobs domain handler) - also anonymous-caller, and unlike the
-- single-business webhook functions above, spans every business with a
-- past_due subscription: business_subscriptions_read and
-- subscription_dunning_events_read both require subscription.read on a
-- specific business, and business_memberships_self_select only shows the
-- caller's own membership rows, so a plain query from the sweep would see
-- nothing at all under any business, not just a wrong one.
-- ============================================================================

-- Mirrors the repository's own lateral-join shape (first failure + reminder
-- count since) but as security definer, since the anonymous scheduler
-- principal has no per-business subscription.read grant to see any of this.
create or replace function app.list_past_due_subscriptions_for_dunning()
returns table ("subscriptionId" uuid, "businessId" uuid, "lastFailureAt" timestamptz, "reminderCount" integer)
language sql stable security definer
set search_path = app, pg_temp
as $$
  select
    subscription."id" as "subscriptionId", subscription."businessId" as "businessId",
    first_failure."createdAt" as "lastFailureAt",
    coalesce(reminder_count."count", 0)::int as "reminderCount"
  from app.business_subscriptions subscription
  join lateral (
    select event."createdAt" from app.subscription_dunning_events event
    where event."subscriptionId" = subscription."id" and event."kind" = 'payment_failed'
    order by event."createdAt" desc limit 1
  ) first_failure on true
  left join lateral (
    select count(*) as "count" from app.subscription_dunning_events event
    where event."subscriptionId" = subscription."id" and event."kind" = 'reminder_sent' and event."createdAt" > first_failure."createdAt"
  ) reminder_count on true
  where subscription."status" = 'past_due';
$$;

revoke all on function app.list_past_due_subscriptions_for_dunning() from public;
grant execute on function app.list_past_due_subscriptions_for_dunning() to surge_app;

-- The active owner's email for a reminder notification - same anonymous-
-- caller gap as above, this time against business_memberships (self-select
-- only) rather than a subscriptions table.
create or replace function app.find_business_owner_email(p_business_id uuid)
returns text
language sql stable security definer
set search_path = app, pg_temp
as $$
  select "user"."email"
  from app.business_memberships membership
  join app.membership_roles membership_role on membership_role."membershipId" = membership."id" and membership_role."businessId" = membership."businessId"
  join app.roles role on role."id" = membership_role."roleId" and role."code" = 'owner'
  join auth.user "user" on "user"."id" = membership."userId"
  where membership."businessId" = p_business_id and membership."status" = 'active'
  limit 1;
$$;

revoke all on function app.find_business_owner_email(uuid) from public;
grant execute on function app.find_business_owner_email(uuid) to surge_app;
