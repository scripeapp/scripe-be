-- Promotions vertical slice: discount definitions and atomic, DB-enforced
-- redemption limits. Ported from legacy discount.service.ts's evaluation
-- logic, which is faithful and well-tested — but legacy never actually
-- recorded a redemption or applied a discount to a completed order anywhere
-- in the codebase, so that write path is new here, not a port.

insert into app.permissions ("code", "description") values
  ('promotion.read', 'View discounts and preview eligible savings'),
  ('promotion.manage', 'Create, update, and archive discounts')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('promotion.read', 'promotion.manage')
on conflict do nothing;

create table app.discounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "kind" text not null check ("kind" in ('code', 'automatic')),
  "name" text not null check (length(trim("name")) between 1 and 100),
  "code" text check ("code" is null or "code" = upper("code")),
  "type" text not null check ("type" in ('percentage', 'fixed')),
  "percentageBps" integer check ("percentageBps" is null or "percentageBps" between 1 and 10000),
  "fixedAmountMinor" bigint check ("fixedAmountMinor" is null or "fixedAmountMinor" > 0),
  "isActive" boolean not null default true,
  "maxUsage" integer check ("maxUsage" is null or "maxUsage" > 0),
  "usageCount" integer not null default 0 check ("usageCount" >= 0),
  "oneUsePerCustomer" boolean not null default false,
  "startsAt" timestamptz,
  "expiresAt" timestamptz,
  "appliesTo" text not null default 'all' check ("appliesTo" in ('all', 'specific_products')),
  "productIds" uuid[] not null default '{}',
  "trigger" text check ("trigger" in ('spend_threshold', 'quantity_bought', 'specific_products', 'first_order')),
  "triggerSpendMinor" bigint check ("triggerSpendMinor" is null or "triggerSpendMinor" > 0),
  "triggerQuantity" integer check ("triggerQuantity" is null or "triggerQuantity" > 0),
  "qualificationProductIds" uuid[] not null default '{}',
  "allowCodeOnTop" boolean not null default false,
  "showOnStorefront" boolean not null default true,
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId"),
  check (("kind" = 'code') = ("code" is not null)),
  check (("kind" = 'automatic') = ("trigger" is not null)),
  check (("type" = 'percentage') = ("percentageBps" is not null)),
  check (("type" = 'fixed') = ("fixedAmountMinor" is not null))
);

create unique index discounts_business_code_unique on app.discounts ("businessId", "code") where "code" is not null and "archivedAt" is null;
create index discounts_business_active_idx on app.discounts ("businessId", "kind", "isActive") where "archivedAt" is null;

create table app.discount_redemptions (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "discountId" uuid not null,
  "orderId" uuid not null,
  "customerPartyId" uuid,
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "createdAt" timestamptz not null default now(),
  foreign key ("discountId", "businessId") references app.discounts ("id", "businessId") on delete restrict,
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict,
  unique ("discountId", "orderId")
);

-- Atomic enforcement of one_use_per_customer: a second redemption attempt by
-- the same customer for the same discount violates this index directly,
-- independent of the application-layer pre-check.
create unique index discount_redemptions_one_per_customer on app.discount_redemptions ("discountId", "customerPartyId") where "customerPartyId" is not null;
create index discount_redemptions_business_idx on app.discount_redemptions ("businessId", "createdAt" desc);

alter table app.discounts enable row level security;
alter table app.discount_redemptions enable row level security;

create policy discounts_read on app.discounts for select
  using (app.has_business_permission("businessId", 'promotion.read'));
create policy discounts_write on app.discounts for all
  using (app.has_business_permission("businessId", 'promotion.manage'))
  with check (app.has_business_permission("businessId", 'promotion.manage'));

-- Redemptions are written only as part of checkout (order.create), not
-- through a direct promotions-write endpoint.
create policy discount_redemptions_read on app.discount_redemptions for select
  using (app.has_business_permission("businessId", 'promotion.read'));
create policy discount_redemptions_insert on app.discount_redemptions for insert
  with check (app.has_business_permission("businessId", 'order.create'));

grant select, insert, update on app.discounts to surge_app;
grant select, insert on app.discount_redemptions to surge_app;

create trigger discounts_set_updated_at before update on app.discounts
  for each row execute function app.set_updated_at();
