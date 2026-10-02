-- 0081_app_paylinks_hardening.sql
-- Fixes found in the payment-links review (0080 is already applied, so
-- every correction lands here rather than by editing 0080):
--   * the public-read RLS policy let any signed-in tenant read every other
--     business's active links; public reads already go through
--     app.get_public_paylink (security definer), so the policy is dropped
--   * composite FKs: ON DELETE SET NULL on ("productVariantId", "businessId")
--     would null the NOT NULL businessId; orders.paylinkId was not
--     tenant-scoped
--   * record_public_paylink_checkout referenced a non-existent
--     app.business_members table and then fell back to an arbitrary user of
--     any business as createdBy; it now falls back to the business creator
--   * replayed idempotency keys return the original checkout instead of
--     failing on payments' unique key
--   * delivery address collected on the pay page is stored on the order
--   * webhook / verify paths can read a payment's expected amount and
--     currency before capturing
--   * a Postgres-backed rate limiter for the public endpoints (shared across
--     API instances)

-- 1. Public reads only through security-definer functions.
drop policy if exists paylinks_public_read on app.paylinks;

-- 2. Foreign keys.
alter table app.paylinks drop constraint if exists "paylinks_productVariantId_businessId_fkey";
alter table app.paylinks add constraint "paylinks_productVariantId_businessId_fkey"
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId")
  on delete set null ("productVariantId");

alter table app.orders drop constraint if exists "orders_paylinkId_fkey";
alter table app.orders add constraint "orders_paylinkId_businessId_fkey"
  foreign key ("paylinkId", "businessId") references app.paylinks ("id", "businessId") on delete restrict;

-- The unique constraint on slug already provides this index.
drop index if exists app.paylinks_slug_idx;

-- 3. Invariants for new and updated rows (NOT VALID: rows created before this
-- migration are not re-checked).
alter table app.paylinks add constraint paylinks_fixed_amount_check
  check ("amountType" <> 'fixed' or "amountMinor" is not null) not valid;
alter table app.paylinks add constraint paylinks_redirect_https_check
  check ("redirectUrl" is null or "redirectUrl" ~ '^https://') not valid;

-- 4. Delivery address captured on the public pay page.
alter table app.orders add column if not exists "deliveryAddress" jsonb
  check ("deliveryAddress" is null or jsonb_typeof("deliveryAddress") = 'object');

-- 5. Hosted checkout URL, so a replayed checkout request can be answered
-- without initializing a second gateway transaction for the same reference.
alter table app.payment_attempts add column if not exists "checkoutUrl" text;

-- 6. Guest checkout, replacing 0080's version.
drop function if exists app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text);

create or replace function app.record_public_paylink_checkout(
  target_slug text,
  customer_name text,
  customer_email text,
  customer_phone text,
  order_num text,
  amt_minor bigint,
  curr text,
  line_desc text,
  variant_id uuid,
  qty integer,
  provider_name text,
  provider_ref text,
  idemp_key text,
  delivery_address jsonb
)
returns table (
  "orderId" uuid,
  "paymentId" uuid,
  "reference" text,
  "checkoutUrl" text,
  "replayed" boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  pl record;
  clean_email text;
  party_id uuid;
  order_id uuid;
  payment_id uuid;
  existing record;
  creator_id uuid;
  safe_qty integer := greatest(1, coalesce(qty, 1));
begin
  if amt_minor is null or amt_minor <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;
  if idemp_key is null or length(idemp_key) = 0 then
    raise exception 'An idempotency key is required';
  end if;

  select * into pl
  from app.paylinks
  where "slug" = target_slug and "status" = 'active'
  limit 1;

  if pl is null then
    raise exception 'Payment link not found or inactive';
  end if;

  if pl."expiresAt" is not null and pl."expiresAt" < now() then
    raise exception 'Payment link has expired';
  end if;

  -- Replay: the same idempotency key on this business returns the original
  -- order, payment and hosted checkout URL.
  select pm."orderId", pm."id", pm."externalReference", pa."checkoutUrl"
    into existing
  from app.payments pm
  left join app.payment_attempts pa on pa."paymentId" = pm."id" and pa."businessId" = pm."businessId"
  where pm."businessId" = pl."businessId" and pm."idempotencyKey" = idemp_key
  order by pa."createdAt" desc nulls last
  limit 1;

  if found then
    return query select existing."orderId", existing."id", existing."externalReference", existing."checkoutUrl", true;
    return;
  end if;

  creator_id := pl."createdBy";
  if creator_id is null then
    select b."createdBy" into creator_id from app.businesses b where b."id" = pl."businessId";
  end if;

  clean_email := lower(trim(customer_email));

  -- Find or create the customer party by email, within this business only.
  select pc."partyId" into party_id
  from app.party_contacts pc
  where pc."businessId" = pl."businessId" and pc."kind" = 'email' and pc."normalizedValue" = clean_email
  order by pc."isPrimary" desc
  limit 1;

  if party_id is null then
    insert into app.parties ("businessId", "kind", "displayName", "status", "createdBy")
    values (pl."businessId", 'person', coalesce(nullif(trim(customer_name), ''), 'Customer'), 'active', creator_id)
    returning "id" into party_id;

    insert into app.party_contacts ("businessId", "partyId", "kind", "value", "normalizedValue", "isPrimary", "status")
    values (pl."businessId", party_id, 'email', trim(customer_email), clean_email, true, 'active');

    if customer_phone is not null and length(trim(customer_phone)) > 0 then
      insert into app.party_contacts ("businessId", "partyId", "kind", "value", "normalizedValue", "isPrimary", "status")
      values (pl."businessId", party_id, 'phone', trim(customer_phone), regexp_replace(trim(customer_phone), '\s+', '', 'g'), false, 'active');
    end if;
  end if;

  insert into app.orders (
    "businessId", "orderNumber", "storeId", "channelId", "customerPartyId",
    "currency", "subtotalMinor", "discountMinor", "taxMinor", "totalMinor",
    "status", "paymentStatus", "fulfillmentStatus", "paylinkId", "createdBy", "deliveryAddress"
  ) values (
    pl."businessId", order_num, pl."storeId", pl."channelId", party_id,
    curr, amt_minor, 0, 0, amt_minor,
    'placed', 'unpaid', 'unfulfilled', pl."id", creator_id, delivery_address
  )
  returning "id" into order_id;

  insert into app.order_lines (
    "businessId", "orderId", "productVariantId", "description",
    "quantity", "unitPriceMinor", "lineTotalMinor", "assetCode"
  ) values (
    pl."businessId", order_id, variant_id, line_desc,
    safe_qty, amt_minor / safe_qty, amt_minor, curr
  );

  insert into app.payments (
    "businessId", "orderId", "method", "status", "assetCode",
    "amountMinor", "externalReference", "idempotencyKey"
  ) values (
    pl."businessId", order_id, 'online', 'pending', curr,
    amt_minor, provider_ref, idemp_key
  )
  returning "id" into payment_id;

  insert into app.payment_attempts (
    "businessId", "paymentId", "provider", "status", "providerReference"
  ) values (
    pl."businessId", payment_id, provider_name, 'initiated', provider_ref
  );

  return query select order_id, payment_id, provider_ref, null::text, false;
end;
$$;

revoke all on function app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text, jsonb) from public;
grant execute on function app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text, jsonb) to scripe_app;

-- 7. Store the hosted checkout URL once the gateway has issued it.
create or replace function app.set_paylink_checkout_url(target_ref text, checkout_url text)
returns void
language sql
volatile
security definer
set search_path = ''
as $$
  update app.payment_attempts pa
  set "checkoutUrl" = checkout_url
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  where pa."providerReference" = target_ref
    and pm."id" = pa."paymentId" and pm."businessId" = pa."businessId"
    and o."paylinkId" is not null;
$$;

revoke all on function app.set_paylink_checkout_url(text, text) from public;
grant execute on function app.set_paylink_checkout_url(text, text) to scripe_app;

-- 8. Expected amount/currency of a checkout payment, for the webhook and the
-- public status path (both run without a business identity).
create or replace function app.get_checkout_payment_by_reference(target_ref text)
returns table (
  "paymentId" uuid,
  "businessId" uuid,
  "orderId" uuid,
  "paylinkId" uuid,
  "status" text,
  "amountMinor" bigint,
  "assetCode" text
)
language sql
stable
security definer
set search_path = ''
as $$
  select pm."id", pm."businessId", pm."orderId", o."paylinkId", pm."status", pm."amountMinor", pm."assetCode"
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  where pm."externalReference" = target_ref
  limit 1;
$$;

revoke all on function app.get_checkout_payment_by_reference(text) from public;
grant execute on function app.get_checkout_payment_by_reference(text) to scripe_app;

-- 9. What the paid-notification emails need for a captured paylink payment.
create or replace function app.get_paylink_payment_notification(target_ref text)
returns table (
  "orderNumber" text,
  "amountMinor" bigint,
  "currency" text,
  "paylinkTitle" text,
  "businessName" text,
  "merchantEmail" text,
  "customerName" text,
  "customerEmail" text
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
      order by pc."isPrimary" desc limit 1)
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

-- 10. Fixed-window rate limiter shared by every API instance.
create table app.rate_limit_counters (
  "bucket" text not null,
  "windowStart" timestamptz not null,
  "hits" integer not null default 0,
  primary key ("bucket", "windowStart")
);
alter table app.rate_limit_counters enable row level security;

create or replace function app.consume_rate_limit(target_bucket text, window_seconds integer, max_hits integer)
returns boolean
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  window_start timestamptz := to_timestamp(floor(extract(epoch from now()) / window_seconds) * window_seconds);
  current_hits integer;
begin
  insert into app.rate_limit_counters ("bucket", "windowStart", "hits")
  values (target_bucket, window_start, 1)
  on conflict ("bucket", "windowStart") do update set "hits" = app.rate_limit_counters."hits" + 1
  returning "hits" into current_hits;

  -- Opportunistic cleanup keeps the table small without a separate job.
  if random() < 0.01 then
    delete from app.rate_limit_counters where "windowStart" < now() - interval '1 day';
  end if;

  return current_hits <= max_hits;
end;
$$;

revoke all on function app.consume_rate_limit(text, integer, integer) from public;
grant execute on function app.consume_rate_limit(text, integer, integer) to scripe_app;
