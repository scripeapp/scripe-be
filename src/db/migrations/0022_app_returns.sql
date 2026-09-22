-- Returns vertical slice: return authorization and line-level disposition,
-- independent of the order's own status (per the approved schema note).
-- Optionally restocks returned quantity via a real stock movement — the
-- inventory domain's stock_transactions.type already included 'return' as a
-- valid value since it was first created, so this integration was expected.
-- The refundable amount is recorded on the return; actually paying it back
-- out belongs to the payments domain's own (not yet built) refund tables —
-- this slice stops at "how much is owed", not "how it gets paid".

insert into app.permissions ("code", "description") values
  ('return.read', 'View return authorizations'),
  ('return.manage', 'Create return authorizations')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('return.read', 'return.manage')
on conflict do nothing;

create table app.returns (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "orderId" uuid not null,
  "reason" text not null check (length(trim("reason")) between 1 and 500),
  "inventoryLocationId" uuid,
  "refundableAmountMinor" bigint not null default 0 check ("refundableAmountMinor" >= 0),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict,
  foreign key ("inventoryLocationId", "businessId") references app.inventory_locations ("id", "businessId") on delete restrict
);
create index returns_business_order_idx on app.returns ("businessId", "orderId", "createdAt" desc);

create table app.return_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "returnId" uuid not null,
  "orderLineId" uuid not null,
  "quantity" integer not null check ("quantity" > 0),
  "condition" text not null check ("condition" in ('sellable', 'damaged', 'defective')),
  "restocked" boolean not null default false,
  "amountMinor" bigint not null check ("amountMinor" >= 0),
  "createdAt" timestamptz not null default now(),
  unique ("id", "businessId"),
  foreign key ("returnId", "businessId") references app.returns ("id", "businessId") on delete cascade,
  foreign key ("orderLineId", "businessId") references app.order_lines ("id", "businessId") on delete restrict
);
create index return_lines_return_idx on app.return_lines ("businessId", "returnId");
create index return_lines_order_line_idx on app.return_lines ("businessId", "orderLineId");

-- Returns are immutable once recorded: no update/delete grant is given below.
alter table app.returns enable row level security;
alter table app.return_lines enable row level security;

create policy returns_read on app.returns for select
  using (app.has_business_permission("businessId", 'return.read'));
create policy returns_insert on app.returns for insert
  with check (app.has_business_permission("businessId", 'return.manage'));
create policy return_lines_read on app.return_lines for select
  using (app.has_business_permission("businessId", 'return.read'));
create policy return_lines_insert on app.return_lines for insert
  with check (app.has_business_permission("businessId", 'return.manage'));

grant select, insert on app.returns, app.return_lines to surge_app;
