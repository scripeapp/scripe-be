insert into app.permissions ("code", "description") values
  ('payment.read', 'View order payments'), ('payment.manage', 'Record and allocate order payments'),
  ('fulfillment.read', 'View order fulfillment'), ('fulfillment.manage', 'Allocate and complete fulfillment')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code"='owner' and role."isSystem" on conflict do nothing;

create table app.payments (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "orderId" uuid not null,
  "method" text not null check ("method" in ('cash','card','bank_transfer','online')), "status" text not null default 'pending' check ("status" in ('pending','authorized','captured','failed','cancelled','refunded')),
  "assetCode" text not null check ("assetCode" ~ '^[A-Z]{3}$'), "amountMinor" bigint not null check ("amountMinor">0), "externalReference" text,
  "idempotencyKey" text not null, "createdBy" uuid references auth.user("id") on delete restrict, "createdAt" timestamptz not null default now(), "updatedAt" timestamptz not null default now(),
  unique ("businessId","idempotencyKey"), unique ("id","businessId"), foreign key ("orderId","businessId") references app.orders("id","businessId") on delete restrict
);
create index payments_order_idx on app.payments ("businessId","orderId","createdAt" desc);
create table app.payment_attempts (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "paymentId" uuid not null, "provider" text,
  "status" text not null default 'initiated' check ("status" in ('initiated','authorized','captured','failed','cancelled')),
  "providerReference" text, "failureReason" text, "createdAt" timestamptz not null default now(),
  foreign key ("paymentId","businessId") references app.payments("id","businessId") on delete restrict
);
create table app.payment_allocations (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "paymentId" uuid not null, "orderId" uuid not null,
  "amountMinor" bigint not null check ("amountMinor">0), "createdAt" timestamptz not null default now(),
  unique ("businessId","paymentId","orderId"), foreign key ("paymentId","businessId") references app.payments("id","businessId") on delete restrict,
  foreign key ("orderId","businessId") references app.orders("id","businessId") on delete restrict
);

create table app.fulfillments (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "orderId" uuid not null, "inventoryLocationId" uuid not null,
  "method" text not null default 'pickup' check ("method" in ('pickup','shipping','delivery')), "status" text not null default 'allocated' check ("status" in ('allocated','packed','fulfilled','cancelled')),
  "trackingReference" text, "createdBy" uuid references auth.user("id") on delete restrict, "createdAt" timestamptz not null default now(), "fulfilledAt" timestamptz,
  unique ("id","businessId"), foreign key ("orderId","businessId") references app.orders("id","businessId") on delete restrict,
  foreign key ("inventoryLocationId","businessId") references app.inventory_locations("id","businessId") on delete restrict
);
create index fulfillments_order_idx on app.fulfillments ("businessId","orderId","createdAt");
create table app.fulfillment_lines (
  "id" uuid primary key default gen_random_uuid(), "businessId" uuid not null, "fulfillmentId" uuid not null, "orderLineId" uuid not null,
  "quantity" integer not null check ("quantity">0), "createdAt" timestamptz not null default now(),
  foreign key ("fulfillmentId","businessId") references app.fulfillments("id","businessId") on delete restrict,
  foreign key ("orderLineId","businessId") references app.order_lines("id","businessId") on delete restrict
);
create index fulfillment_lines_lookup_idx on app.fulfillment_lines ("businessId","orderLineId");

create trigger payments_set_updated_at before update on app.payments for each row execute function app.set_updated_at();
alter table app.payments enable row level security; alter table app.payment_attempts enable row level security; alter table app.payment_allocations enable row level security; alter table app.fulfillments enable row level security; alter table app.fulfillment_lines enable row level security;
create policy payments_read on app.payments for select using (app.has_business_permission("businessId",'payment.read')); create policy payments_write on app.payments for all using (app.has_business_permission("businessId",'payment.manage')) with check (app.has_business_permission("businessId",'payment.manage'));
create policy payment_attempts_read on app.payment_attempts for select using (app.has_business_permission("businessId",'payment.read')); create policy payment_attempts_write on app.payment_attempts for all using (app.has_business_permission("businessId",'payment.manage')) with check (app.has_business_permission("businessId",'payment.manage'));
create policy payment_allocations_read on app.payment_allocations for select using (app.has_business_permission("businessId",'payment.read')); create policy payment_allocations_write on app.payment_allocations for insert with check (app.has_business_permission("businessId",'payment.manage'));
create policy fulfillments_read on app.fulfillments for select using (app.has_business_permission("businessId",'fulfillment.read')); create policy fulfillments_write on app.fulfillments for all using (app.has_business_permission("businessId",'fulfillment.manage')) with check (app.has_business_permission("businessId",'fulfillment.manage'));
create policy fulfillment_lines_read on app.fulfillment_lines for select using (app.has_business_permission("businessId",'fulfillment.read')); create policy fulfillment_lines_write on app.fulfillment_lines for all using (app.has_business_permission("businessId",'fulfillment.manage')) with check (app.has_business_permission("businessId",'fulfillment.manage'));
grant select, insert, update on app.payments, app.payment_attempts, app.payment_allocations, app.fulfillments, app.fulfillment_lines to surge_app;
