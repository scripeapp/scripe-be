-- 0080_app_paylinks.sql
-- Payment links domain: shareable payment, product, and donation links.
-- Allows merchants to create public links, receive payments, and record them as orders.

-- 1. Permissions
insert into app.permissions ("code", "description") values
  ('paylink.read', 'View payment links, analytics, and associated payments'),
  ('paylink.manage', 'Create, update, pause, and archive payment links')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('paylink.read', 'paylink.manage')
on conflict do nothing;

-- 2. Expand sales channels kind check constraint to include 'payment_link'
alter table app.sales_channels drop constraint if exists "sales_channels_kind_check";
alter table app.sales_channels add constraint "sales_channels_kind_check"
  check ("kind" in ('storefront', 'pos', 'manual_invoice', 'payment_link', 'qr', 'other'));

-- 3. Seed payment_link channel for all existing stores that lack one
insert into app.sales_channels ("businessId", "storeId", "code", "name", "kind", "status")
select s."businessId", s."id", 'payment_link', 'Payment Links', 'payment_link', 'active'
from app.stores s
where not exists (
  select 1 from app.sales_channels sc
  where sc."businessId" = s."businessId" and sc."storeId" = s."id" and sc."kind" = 'payment_link'
);

-- 4. Paylinks table
create table app.paylinks (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "storeId" uuid not null,
  "channelId" uuid not null,
  "slug" text not null unique check ("slug" ~ '^[a-z0-9-]{3,60}$'),
  "mode" text not null check ("mode" in ('take_payment', 'product', 'donation')),
  "title" text not null,
  "description" text,
  "imageKey" text,
  "amountType" text not null default 'fixed' check ("amountType" in ('fixed', 'customer_sets')),
  "amountMinor" bigint check ("amountMinor" is null or "amountMinor" > 0),
  "minAmountMinor" bigint check ("minAmountMinor" is null or "minAmountMinor" > 0),
  "suggestedAmountsMinor" jsonb not null default '[]'::jsonb check (jsonb_typeof("suggestedAmountsMinor") = 'array'),
  "currency" text not null default 'NGN' check ("currency" ~ '^[A-Z]{3}$'),
  "productVariantId" uuid,
  "collectName" boolean not null default true,
  "collectPhone" boolean not null default true,
  "collectAddress" boolean not null default false,
  "redirectUrl" text,
  "status" text not null default 'active' check ("status" in ('active', 'paused', 'archived')),
  "expiresAt" timestamptz,
  "createdBy" uuid references auth.user ("id") on delete set null,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("channelId", "storeId", "businessId") references app.sales_channels ("id", "storeId", "businessId") on delete restrict,
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete set null
);

create index paylinks_business_status_idx on app.paylinks ("businessId", "status", "createdAt" desc);
create index paylinks_slug_idx on app.paylinks ("slug");
create trigger paylinks_set_updated_at before update on app.paylinks for each row execute function app.set_updated_at();

-- 5. Add paylinkId to app.orders
alter table app.orders add column if not exists "paylinkId" uuid references app.paylinks ("id") on delete set null;
create index if not exists orders_paylink_idx on app.orders ("businessId", "paylinkId") where "paylinkId" is not null;

-- 6. RLS policies on app.paylinks
alter table app.paylinks enable row level security;

create policy paylinks_read on app.paylinks for select
  using (app.has_business_permission("businessId", 'paylink.read'));

create policy paylinks_manage on app.paylinks for all
  using (app.has_business_permission("businessId", 'paylink.manage'))
  with check (app.has_business_permission("businessId", 'paylink.manage'));

create policy paylinks_public_read on app.paylinks for select
  using ("status" = 'active');

grant select, insert, update on app.paylinks to scripe_app;

-- 7. Public Security Definer Functions

create or replace function app.get_public_paylink(target_slug text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  pl record;
  biz_name text := 'Merchant';
  prod record;
  prod_json jsonb := null;
begin
  select * into pl
  from app.paylinks
  where "slug" = target_slug and "status" = 'active'
  limit 1;

  if pl is null then
    return null;
  end if;

  if pl."expiresAt" is not null and pl."expiresAt" < now() then
    return null;
  end if;

  select "displayName" into biz_name
  from app.businesses
  where "id" = pl."businessId";

  if pl."mode" = 'product' and pl."productVariantId" is not null then
    select
      p."name" as product_name,
      v."name" as variant_name,
      v."sku",
      p."description"
    into prod
    from app.product_variants v
    join app.products p on p."id" = v."productId" and p."businessId" = v."businessId"
    where v."id" = pl."productVariantId" and v."businessId" = pl."businessId"
    limit 1;

    if prod is not null then
      prod_json := jsonb_build_object(
        'name', case when prod.variant_name is not null and prod.variant_name <> 'Default'
                  then prod.product_name || ' (' || prod.variant_name || ')'
                  else prod.product_name end,
        'sku', prod."sku",
        'description', prod."description"
      );
    end if;
  end if;

  return jsonb_build_object(
    'id', pl."id",
    'businessId', pl."businessId",
    'storeId', pl."storeId",
    'channelId', pl."channelId",
    'slug', pl."slug",
    'mode', pl."mode",
    'title', pl."title",
    'description', pl."description",
    'imageKey', pl."imageKey",
    'amountType', pl."amountType",
    'amountMinor', case when pl."amountMinor" is not null then pl."amountMinor"::text else null end,
    'minAmountMinor', case when pl."minAmountMinor" is not null then pl."minAmountMinor"::text else null end,
    'suggestedAmountsMinor', pl."suggestedAmountsMinor",
    'currency', pl."currency",
    'productVariantId', pl."productVariantId",
    'collectName', pl."collectName",
    'collectPhone', pl."collectPhone",
    'collectAddress', pl."collectAddress",
    'redirectUrl', pl."redirectUrl",
    'status', pl."status",
    'expiresAt', pl."expiresAt",
    'businessName', coalesce(biz_name, 'Merchant'),
    'product', prod_json
  );
end;
$$;

revoke all on function app.get_public_paylink(text) from public;
grant execute on function app.get_public_paylink(text) to scripe_app;

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
  idemp_key text
)
returns table (
  "orderId" uuid,
  "paymentId" uuid
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
  unit_price bigint;
  creator_id uuid;
begin
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

  creator_id := pl."createdBy";
  if creator_id is null then
    select m."userId" into creator_id
    from app.business_members m
    join app.roles r on r."id" = m."roleId"
    where m."businessId" = pl."businessId" and r."code" = 'owner'
    limit 1;
  end if;

  if creator_id is null then
    select u."id" into creator_id
    from auth.user u
    limit 1;
  end if;

  clean_email := lower(trim(customer_email));

  -- 1. Find or create customer party
  select pc."partyId" into party_id
  from app.party_contacts pc
  where pc."businessId" = pl."businessId" and pc."kind" = 'email' and pc."normalizedValue" = clean_email
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

  -- 2. Insert order
  insert into app.orders (
    "businessId", "orderNumber", "storeId", "channelId", "customerPartyId",
    "currency", "subtotalMinor", "discountMinor", "taxMinor", "totalMinor",
    "status", "paymentStatus", "fulfillmentStatus", "paylinkId", "createdBy"
  ) values (
    pl."businessId",
    order_num,
    pl."storeId",
    pl."channelId",
    party_id,
    curr,
    amt_minor,
    0,
    0,
    amt_minor,
    'placed',
    'unpaid',
    'unfulfilled',
    pl."id",
    creator_id
  )
  returning "id" into order_id;

  -- 3. Insert order line
  if qty > 0 then
    unit_price := amt_minor / qty;
  else
    unit_price := amt_minor;
  end if;

  insert into app.order_lines (
    "businessId", "orderId", "productVariantId", "description",
    "quantity", "unitPriceMinor", "lineTotalMinor", "assetCode"
  ) values (
    pl."businessId",
    order_id,
    variant_id,
    line_desc,
    greatest(1, qty),
    unit_price,
    amt_minor,
    curr
  );

  -- 4. Insert pending payment
  insert into app.payments (
    "businessId", "orderId", "method", "status", "assetCode",
    "amountMinor", "externalReference", "idempotencyKey"
  ) values (
    pl."businessId",
    order_id,
    'online',
    'pending',
    curr,
    amt_minor,
    provider_ref,
    idemp_key
  )
  returning "id" into payment_id;

  -- 5. Insert payment attempt
  insert into app.payment_attempts (
    "businessId", "paymentId", "provider", "status", "providerReference"
  ) values (
    pl."businessId",
    payment_id,
    provider_name,
    'initiated',
    provider_ref
  );

  return query select order_id, payment_id;
end;
$$;

revoke all on function app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text) from public;
grant execute on function app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text) to scripe_app;

create or replace function app.get_public_paylink_checkout_status(target_ref text)
returns table (
  "reference" text,
  "status" text,
  "amountMinor" text,
  "currency" text,
  "paidAt" timestamptz,
  "redirectUrl" text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    pm."externalReference" as "reference",
    pm."status",
    pm."amountMinor"::text as "amountMinor",
    pm."assetCode" as "currency",
    case when pm."status" = 'captured' then pm."updatedAt" else null end as "paidAt",
    pl."redirectUrl"
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  left join app.paylinks pl on pl."id" = o."paylinkId" and pl."businessId" = o."businessId"
  where pm."externalReference" = target_ref
  limit 1;
end;
$$;

revoke all on function app.get_public_paylink_checkout_status(text) from public;
grant execute on function app.get_public_paylink_checkout_status(text) to scripe_app;
