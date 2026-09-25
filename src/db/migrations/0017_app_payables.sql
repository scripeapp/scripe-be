insert into app.permissions ("code", "description") values
  ('payables.read', 'View business bills and payables'),
  ('payables.manage', 'Create, approve, void, and allocate bill payments')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
on conflict do nothing;

create table app.bills (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "supplierAccountId" uuid,
  "billNumber" text not null,
  "billType" text not null default 'supplier' check ("billType" in ('supplier','utility','tax','rent','other')),
  "status" text not null default 'draft' check ("status" in ('draft','approved','partially_paid','paid','voided')),
  "assetCode" text not null default 'NGN' check ("assetCode" ~ '^[A-Z0-9]{2,12}$'),
  "issuedAt" date,
  "dueAt" date,
  "subtotalMinor" bigint not null default 0 check ("subtotalMinor" >= 0),
  "taxMinor" bigint not null default 0 check ("taxMinor" >= 0),
  "totalMinor" bigint not null check ("totalMinor" >= 0),
  "amountPaidMinor" bigint not null default 0 check ("amountPaidMinor" >= 0 and "amountPaidMinor" <= "totalMinor"),
  "notes" text not null default '',
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  unique ("businessId", "billNumber"),
  unique ("id", "businessId"),
  foreign key ("supplierAccountId", "businessId") references app.supplier_accounts ("id", "businessId") on delete restrict,
  check ("dueAt" is null or "issuedAt" is null or "dueAt" >= "issuedAt")
);
create index bills_actionable_idx on app.bills ("businessId", "status", "dueAt") where "status" in ('approved','partially_paid');

create table app.bill_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "billId" uuid not null,
  "description" text not null check (length(trim("description")) between 1 and 500),
  "quantity" numeric(20,6) not null default 1 check ("quantity" > 0),
  "unitAmountMinor" bigint not null check ("unitAmountMinor" >= 0),
  "taxMinor" bigint not null default 0 check ("taxMinor" >= 0),
  "lineTotalMinor" bigint not null check ("lineTotalMinor" >= 0),
  "accountCategory" text not null,
  "purchaseOrderId" uuid,
  "purchaseOrderLineId" uuid,
  "goodsReceiptId" uuid,
  "createdAt" timestamptz not null default now(),
  foreign key ("billId", "businessId") references app.bills ("id", "businessId") on delete restrict,
  foreign key ("purchaseOrderId", "businessId") references app.purchase_orders ("id", "businessId") on delete restrict,
  foreign key ("purchaseOrderLineId", "businessId") references app.purchase_order_lines ("id", "businessId") on delete restrict,
  foreign key ("goodsReceiptId", "businessId") references app.goods_receipts ("id", "businessId") on delete restrict
);
create index bill_lines_bill_idx on app.bill_lines ("businessId", "billId");

create table app.bill_payment_allocations (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "billId" uuid not null,
  "paymentReference" text not null,
  "amountMinor" bigint not null check ("amountMinor" > 0),
  "assetCode" text not null check ("assetCode" ~ '^[A-Z0-9]{2,12}$'),
  "paidAt" timestamptz not null default now(),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "paymentReference", "billId"),
  foreign key ("billId", "businessId") references app.bills ("id", "businessId") on delete restrict
);
create index bill_payment_allocations_bill_idx on app.bill_payment_allocations ("businessId", "billId", "paidAt" desc);
create trigger bills_set_updated_at before update on app.bills for each row execute function app.set_updated_at();

alter table app.bills enable row level security;
alter table app.bill_lines enable row level security;
alter table app.bill_payment_allocations enable row level security;
create policy bills_read on app.bills for select using (app.has_business_permission("businessId", 'payables.read'));
create policy bills_write on app.bills for all using (app.has_business_permission("businessId", 'payables.manage')) with check (app.has_business_permission("businessId", 'payables.manage'));
create policy bill_lines_read on app.bill_lines for select using (app.has_business_permission("businessId", 'payables.read'));
create policy bill_lines_write on app.bill_lines for all using (app.has_business_permission("businessId", 'payables.manage')) with check (app.has_business_permission("businessId", 'payables.manage'));
create policy bill_payment_allocations_read on app.bill_payment_allocations for select using (app.has_business_permission("businessId", 'payables.read'));
create policy bill_payment_allocations_write on app.bill_payment_allocations for insert with check (app.has_business_permission("businessId", 'payables.manage'));
grant select, insert, update on app.bills, app.bill_lines, app.bill_payment_allocations to scripe_app;
