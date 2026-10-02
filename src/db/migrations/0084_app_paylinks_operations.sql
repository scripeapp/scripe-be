-- 0084_app_paylinks_operations.sql
-- What payment links need to run unattended in production:
--   * a plan limit on active links (app.platform_plan_entitlements; a plan
--     with no row - pro - stays unlimited, the convention 0041 set)
--   * one predicate for "may this business take payments right now"
--     (business active, no risk hold), usable from the anonymous public path
--   * the queries behind the pending-payment reconciliation job and its
--     alerts (the job runs without a business identity)
--   * who to notify in the app when a paylink payment is captured

-- 1. Plan limit. Values are a starting point; change them by updating rows.
insert into app.platform_plan_entitlements ("planCode", "key", "kind", "limitValue") values
  ('starter', 'active_paylinks', 'limit', 10),
  ('plus', 'active_paylinks', 'limit', 50)
on conflict ("planCode", "key") do nothing;

-- 2. Whether a business may currently accept payments: it must be active
-- and carry no active transaction hold (risk domain, 0038).
create or replace function app.business_accepting_payments(target_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select exists (select 1 from app.businesses b where b."id" = target_business_id and b."status" = 'active')
    and not app.has_active_transaction_hold('business', target_business_id);
$$;

revoke all on function app.business_accepting_payments(uuid) from public;
grant execute on function app.business_accepting_payments(uuid) to scripe_app;

-- 3. Paylink payments still pending after a while: the reconciliation job
-- re-verifies these with the gateway (a webhook can be lost, and a customer
-- can close the tab before the completion page polls).
-- Paged by createdAt (pass the last row's createdAt as after_created_at) so
-- one run can walk every stale payment instead of only the oldest batch.
create or replace function app.list_stale_paylink_payments(older_than interval, after_created_at timestamptz, max_rows integer)
returns table ("reference" text, "createdAt" timestamptz)
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select pm."externalReference", pm."createdAt"
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  where o."paylinkId" is not null
    and pm."status" = 'pending'
    and pm."externalReference" is not null
    and pm."createdAt" < now() - older_than
    and (after_created_at is null or pm."createdAt" > after_created_at)
  order by pm."createdAt"
  limit max_rows;
$$;

revoke all on function app.list_stale_paylink_payments(interval, timestamptz, integer) from public;
grant execute on function app.list_stale_paylink_payments(interval, timestamptz, integer) to scripe_app;

-- 4. Webhook deliveries whose signature failed recently: a burst means a
-- wrong secret in production or someone probing the webhook endpoint.
create or replace function app.count_recent_webhook_signature_failures(within interval)
returns integer
language sql
stable
security definer
set search_path = app, pg_temp
as $$
  select count(*)::integer from app.provider_events
  where "signatureValid" = false and "receivedAt" > now() - within;
$$;

revoke all on function app.count_recent_webhook_signature_failures(interval) from public;
grant execute on function app.count_recent_webhook_signature_failures(interval) to scripe_app;

-- 5. Paid-notification details, extended from 0081 with who to notify in
-- the app (the business creator, as invoices do) and the ids the
-- notification links to. Dropped first: the result columns changed.
drop function if exists app.get_paylink_payment_notification(text);

create function app.get_paylink_payment_notification(target_ref text)
returns table (
  "orderNumber" text,
  "amountMinor" bigint,
  "currency" text,
  "paylinkTitle" text,
  "businessName" text,
  "merchantEmail" text,
  "customerName" text,
  "customerEmail" text,
  "businessId" uuid,
  "paylinkId" uuid,
  "orderId" uuid,
  "ownerUserId" uuid
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o."orderNumber",
    pm."amountMinor",
    pm."assetCode",
    pl."title",
    b."displayName",
    u."email",
    party."displayName",
    (select pc."value" from app.party_contacts pc
      where pc."partyId" = party."id" and pc."businessId" = party."businessId" and pc."kind" = 'email'
      order by pc."isPrimary" desc limit 1),
    o."businessId",
    pl."id",
    o."id",
    b."createdBy"
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  join app.paylinks pl on pl."id" = o."paylinkId" and pl."businessId" = o."businessId"
  join app.businesses b on b."id" = o."businessId"
  left join auth.user u on u."id" = b."createdBy"
  left join app.parties party on party."id" = o."customerPartyId" and party."businessId" = o."businessId"
  where pm."externalReference" = target_ref and pm."status" = 'captured'
  limit 1;
$$;

revoke all on function app.get_paylink_payment_notification(text) from public;
grant execute on function app.get_paylink_payment_notification(text) to scripe_app;
