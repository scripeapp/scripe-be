-- 0076_app_invoices.sql
-- Invoices domain: draft/open/void lifecycle, invoice lines, and public token.
-- Bridges to app.orders, app.payments, and app.fiscal_documents.

-- 1. Order lines adjustment: allow free-text custom invoice items without catalog variants
alter table app.order_lines alter column "productVariantId" drop not null;

-- 2. Fiscal documents sequence adjustment: per-kind sequence series (INV-000001 vs RCT-000001)
alter table app.fiscal_documents drop constraint "fiscal_documents_businessId_sequence_key";
alter table app.fiscal_documents add constraint fiscal_documents_business_kind_sequence_unique unique ("businessId", "kind", "sequence");
create unique index fiscal_documents_invoice_per_order_unique on app.fiscal_documents ("orderId") where "kind" = 'invoice';

-- 3. Fiscal documents RLS expansion: allow invoice permissions
drop policy if exists fiscal_documents_read on app.fiscal_documents;
create policy fiscal_documents_read on app.fiscal_documents for select
  using (app.has_business_permission("businessId", 'receipt.read') or app.has_business_permission("businessId", 'invoice.read'));

drop policy if exists fiscal_documents_insert on app.fiscal_documents;
create policy fiscal_documents_insert on app.fiscal_documents for insert
  with check (app.has_business_permission("businessId", 'payment.manage') or app.has_business_permission("businessId", 'invoice.manage'));

-- 4. Permissions
insert into app.permissions ("code", "description") values
  ('invoice.read', 'View invoices, lines, and payment links'),
  ('invoice.manage', 'Create, update, send, void, and record payments on invoices')
on conflict ("code") do nothing;

insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id" from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner' and role."isSystem"
  and permission."code" in ('invoice.read', 'invoice.manage')
on conflict do nothing;

-- 5. Seed manual_invoice channel for all existing stores that lack one
insert into app.sales_channels ("businessId", "storeId", "code", "name", "kind", "status")
select s."businessId", s."id", 'manual_invoice', 'Manual Invoices', 'manual_invoice', 'active'
from app.stores s
where not exists (
  select 1 from app.sales_channels sc
  where sc."businessId" = s."businessId" and sc."storeId" = s."id" and sc."kind" = 'manual_invoice'
);

-- 6. Invoices table
create table app.invoices (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "storeId" uuid not null,
  "channelId" uuid not null,
  "customerPartyId" uuid,
  "orderId" uuid,
  "fiscalDocumentId" uuid,
  "status" text not null default 'draft' check ("status" in ('draft', 'open', 'void')),
  "invoiceNumber" text,
  "issueDate" date not null default current_date,
  "dueDate" date not null,
  "currency" text not null default 'NGN' check ("currency" ~ '^[A-Z]{3}$'),
  "subtotalMinor" bigint not null default 0 check ("subtotalMinor" >= 0),
  "taxMinor" bigint not null default 0 check ("taxMinor" >= 0),
  "discountMinor" bigint not null default 0 check ("discountMinor" >= 0),
  "totalMinor" bigint not null default 0 check ("totalMinor" >= 0),
  "notes" text,
  "terms" text,
  "publicToken" text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  "payToVirtualAccountId" uuid,
  "payToBankName" text,
  "payToAccountNumber" text,
  "payToAccountName" text,
  "sentAt" timestamptz,
  "voidedAt" timestamptz,
  "lastReminderAt" timestamptz,
  "createdBy" uuid not null references auth."user" ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("storeId", "businessId") references app.stores ("id", "businessId") on delete restrict,
  foreign key ("channelId", "storeId", "businessId") references app.sales_channels ("id", "storeId", "businessId") on delete restrict,
  foreign key ("customerPartyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  foreign key ("orderId", "businessId") references app.orders ("id", "businessId") on delete set null,
  foreign key ("fiscalDocumentId") references app.fiscal_documents ("id") on delete set null,
  unique ("id", "businessId"),
  unique ("businessId", "invoiceNumber")
);

create trigger invoices_set_updated_at before update on app.invoices
  for each row execute function app.set_updated_at();

create index invoices_business_idx on app.invoices ("businessId", "createdAt" desc);
create index invoices_business_status_idx on app.invoices ("businessId", "status", "dueDate");
create index invoices_public_token_idx on app.invoices ("publicToken");
create index invoices_order_idx on app.invoices ("orderId") where "orderId" is not null;

-- 7. Invoice lines table
create table app.invoice_lines (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "invoiceId" uuid not null,
  "productVariantId" uuid,
  "description" text not null check (length(trim("description")) between 1 and 255),
  "quantity" numeric(12, 4) not null default 1 check ("quantity" > 0),
  "unitPriceMinor" bigint not null check ("unitPriceMinor" >= 0),
  "taxRateBps" integer not null default 0 check ("taxRateBps" >= 0 and "taxRateBps" <= 10000),
  "discountMinor" bigint not null default 0 check ("discountMinor" >= 0),
  "lineTotalMinor" bigint not null check ("lineTotalMinor" >= 0),
  "sortOrder" integer not null default 0,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("invoiceId", "businessId") references app.invoices ("id", "businessId") on delete cascade,
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete set null
);

create trigger invoice_lines_set_updated_at before update on app.invoice_lines
  for each row execute function app.set_updated_at();

create index invoice_lines_invoice_idx on app.invoice_lines ("businessId", "invoiceId", "sortOrder", "createdAt");

-- 8. Row Level Security
alter table app.invoices enable row level security;
alter table app.invoice_lines enable row level security;

create policy invoices_read on app.invoices for select
  using (app.has_business_permission("businessId", 'invoice.read'));
create policy invoices_insert on app.invoices for insert
  with check (app.has_business_permission("businessId", 'invoice.manage'));
create policy invoices_update on app.invoices for update
  using (app.has_business_permission("businessId", 'invoice.manage'))
  with check (app.has_business_permission("businessId", 'invoice.manage'));
create policy invoices_delete on app.invoices for delete
  using (app.has_business_permission("businessId", 'invoice.manage') and "status" = 'draft');

create policy invoice_lines_read on app.invoice_lines for select
  using (app.has_business_permission("businessId", 'invoice.read'));
create policy invoice_lines_insert on app.invoice_lines for insert
  with check (app.has_business_permission("businessId", 'invoice.manage'));
create policy invoice_lines_update on app.invoice_lines for update
  using (app.has_business_permission("businessId", 'invoice.manage'))
  with check (app.has_business_permission("businessId", 'invoice.manage'));
create policy invoice_lines_delete on app.invoice_lines for delete
  using (app.has_business_permission("businessId", 'invoice.manage'));

grant select, insert, update, delete on app.invoices, app.invoice_lines to scripe_app;

-- 9. Security definer function for public invoice presentation
create or replace function app.get_public_invoice(target_token text)
returns jsonb
language plpgsql stable security definer
set search_path = app, pg_temp
as $$
declare
  inv record;
  ord record;
  biz record;
  cust record;
  lines_json jsonb;
  paid_minor bigint := 0;
  total_minor bigint := 0;
  calculated_status text;
begin
  select i.* into inv
  from app.invoices i
  where i."publicToken" = target_token and i."status" <> 'draft'
  limit 1;

  if inv is null then
    return null;
  end if;

  select b."displayName" into biz
  from app.businesses b
  where b."id" = inv."businessId";

  if inv."customerPartyId" is not null then
    select p."displayName" as "name",
      (select pc."value" from app.party_contacts pc
       where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'email' and pc."status" = 'active'
       order by pc."isPrimary" desc, pc."createdAt" limit 1) as "email",
      (select pc."value" from app.party_contacts pc
       where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'phone' and pc."status" = 'active'
       order by pc."isPrimary" desc, pc."createdAt" limit 1) as "phone"
    into cust
    from app.parties p
    where p."id" = inv."customerPartyId" and p."businessId" = inv."businessId";
  end if;

  if inv."orderId" is not null then
    select o."paymentStatus", o."totalMinor" into ord
    from app.orders o
    where o."id" = inv."orderId" and o."businessId" = inv."businessId";

    select coalesce(sum(p."amountMinor"), 0) into paid_minor
    from app.payments p
    where p."orderId" = inv."orderId" and p."businessId" = inv."businessId" and p."status" in ('captured', 'authorized');
  end if;

  total_minor := inv."totalMinor";

  if inv."status" = 'void' then
    calculated_status := 'void';
  elsif ord."paymentStatus" = 'paid' or (total_minor > 0 and paid_minor >= total_minor) then
    calculated_status := 'paid';
  elsif paid_minor > 0 then
    calculated_status := 'partially_paid';
  elsif inv."dueDate" < current_date then
    calculated_status := 'overdue';
  else
    calculated_status := 'pending';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', l."id",
      'description', l."description",
      'quantity', l."quantity",
      'unitPriceMinor', l."unitPriceMinor",
      'taxRateBps', l."taxRateBps",
      'discountMinor', l."discountMinor",
      'lineTotalMinor', l."lineTotalMinor",
      'productVariantId', l."productVariantId"
    ) order by l."sortOrder", l."createdAt"
  ), '[]'::jsonb)
  into lines_json
  from app.invoice_lines l
  where l."invoiceId" = inv."id";

  return jsonb_build_object(
    'id', inv."id",
    'invoiceNumber', inv."invoiceNumber",
    'status', calculated_status,
    'documentStatus', inv."status",
    'issueDate', inv."issueDate",
    'dueDate', inv."dueDate",
    'currency', inv."currency",
    'subtotalMinor', inv."subtotalMinor",
    'taxMinor', inv."taxMinor",
    'discountMinor', inv."discountMinor",
    'totalMinor', total_minor,
    'amountPaidMinor', paid_minor,
    'balanceDueMinor', greatest(0, total_minor - paid_minor),
    'notes', inv."notes",
    'terms', inv."terms",
    'sentAt', inv."sentAt",
    'business', jsonb_build_object(
      'displayName', biz."displayName"
    ),
    'customer', jsonb_build_object(
      'name', cust."name",
      'email', cust."email",
      'phone', cust."phone"
    ),
    'bankDetails', case when inv."payToAccountNumber" is not null then jsonb_build_object(
      'bankName', inv."payToBankName",
      'accountNumber', inv."payToAccountNumber",
      'accountName', inv."payToAccountName"
    ) else null end,
    'lines', lines_json
  );
end;
$$;

revoke all on function app.get_public_invoice(text) from public;
grant execute on function app.get_public_invoice(text) to scripe_app;
