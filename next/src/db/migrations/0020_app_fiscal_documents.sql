-- Receipts vertical slice: immutable numbered fiscal documents. This slice
-- only issues the 'receipt' kind, generated automatically when an order
-- becomes fully paid (see payments.service.ts). 'invoice' and 'credit_note'
-- are reserved kinds for future slices — invoicing has no evidenced trigger
-- yet, and credit notes belong with the (currently unbuilt) returns domain.

insert into app.permissions ("code", "description") values
  ('receipt.read', 'View fiscal receipts, invoices, and credit notes')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" = 'receipt.read'
on conflict do nothing;

create table app.fiscal_documents (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "orderId" uuid not null,
  "kind" text not null default 'receipt' check ("kind" in ('receipt', 'invoice', 'credit_note')),
  "sequence" bigint not null check ("sequence" > 0),
  "number" text not null,
  "currency" text not null check ("currency" ~ '^[A-Z]{3}$'),
  "subtotalMinor" bigint not null check ("subtotalMinor" >= 0),
  "taxMinor" bigint not null default 0 check ("taxMinor" >= 0),
  "totalMinor" bigint not null check ("totalMinor" >= 0),
  "issuedAt" timestamptz not null default now(),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete restrict,
  unique ("businessId", "sequence"),
  unique ("businessId", "number")
);

-- One receipt per order. Invoices/credit notes are not issued by this slice,
-- so no analogous constraint exists for those kinds yet.
create unique index fiscal_documents_receipt_per_order_unique on app.fiscal_documents ("orderId") where "kind" = 'receipt';
create index fiscal_documents_business_idx on app.fiscal_documents ("businessId", "issuedAt" desc);

alter table app.fiscal_documents enable row level security;

-- Fiscal documents are issued only as a side effect of recording a payment
-- (see receipts.repository.ts issueReceipt, called from payments.service.ts
-- inside the same transaction), so the same trust level that can record a
-- payment can cause one to be issued — no separate write permission exists.
create policy fiscal_documents_read on app.fiscal_documents for select
  using (app.has_business_permission("businessId", 'receipt.read'));
create policy fiscal_documents_insert on app.fiscal_documents for insert
  with check (app.has_business_permission("businessId", 'payment.manage'));

grant select, insert on app.fiscal_documents to surge_app;

comment on table app.fiscal_documents is 'Immutable; never updated or deleted once issued.';
