-- Wave B: one business-scoped identity model for customers and suppliers.

create table app.parties (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "kind" text not null check ("kind" in ('person', 'organization')),
  "displayName" text not null check (length(trim("displayName")) between 1 and 200),
  "legalName" text,
  "status" text not null default 'active' check ("status" in ('active', 'inactive', 'archived')),
  "createdBy" uuid not null references auth.user ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  "archivedAt" timestamptz,
  unique ("id", "businessId")
);

create index parties_business_status_idx
  on app.parties ("businessId", "status", "createdAt" desc, "id" desc);
create index parties_business_name_idx
  on app.parties ("businessId", lower("displayName"));

create table app.party_contacts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "partyId" uuid not null,
  "kind" text not null check ("kind" in ('email', 'phone')),
  "value" text not null check (length(trim("value")) between 1 and 320),
  "normalizedValue" text not null check (length(trim("normalizedValue")) between 1 and 320),
  "label" text,
  "isPrimary" boolean not null default false,
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("partyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  unique ("id", "businessId"),
  unique ("partyId", "kind", "normalizedValue")
);
create unique index party_contacts_one_primary_kind
  on app.party_contacts ("partyId", "kind") where "isPrimary" and "status" = 'active';
create index party_contacts_party_idx on app.party_contacts ("businessId", "partyId", "status");

create table app.party_addresses (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "partyId" uuid not null,
  "kind" text not null check ("kind" in ('billing', 'shipping', 'office', 'other')),
  "label" text,
  "line1" text not null check (length(trim("line1")) between 1 and 240),
  "line2" text,
  "city" text,
  "state" text,
  "postalCode" text,
  "countryCode" text not null default 'NG' check ("countryCode" ~ '^[A-Z]{2}$'),
  "isDefault" boolean not null default false,
  "status" text not null default 'active' check ("status" in ('active', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("partyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  unique ("id", "businessId")
);
create unique index party_addresses_one_default_kind
  on app.party_addresses ("partyId", "kind") where "isDefault" and "status" = 'active';
create index party_addresses_party_idx on app.party_addresses ("businessId", "partyId", "status");

create table app.customer_accounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "partyId" uuid not null,
  "acquisitionChannel" text,
  "lifecycleState" text not null default 'active' check ("lifecycleState" in ('lead', 'active', 'inactive', 'blocked')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("partyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  unique ("partyId", "businessId"),
  unique ("id", "businessId")
);
create index customer_accounts_business_idx on app.customer_accounts ("businessId", "lifecycleState", "createdAt" desc);

create table app.supplier_accounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null,
  "partyId" uuid not null,
  "code" text,
  "paymentTerms" text not null default 'Net 30',
  "taxId" text,
  "status" text not null default 'active' check ("status" in ('active', 'inactive', 'archived')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now(),
  foreign key ("partyId", "businessId") references app.parties ("id", "businessId") on delete restrict,
  unique ("partyId", "businessId"),
  unique ("id", "businessId")
);
create unique index supplier_accounts_business_code_idx
  on app.supplier_accounts ("businessId", "code") where "code" is not null;
create index supplier_accounts_business_status_idx
  on app.supplier_accounts ("businessId", "status", "createdAt" desc);

create trigger parties_set_updated_at before update on app.parties for each row execute function app.set_updated_at();
create trigger party_contacts_set_updated_at before update on app.party_contacts for each row execute function app.set_updated_at();
create trigger party_addresses_set_updated_at before update on app.party_addresses for each row execute function app.set_updated_at();
create trigger customer_accounts_set_updated_at before update on app.customer_accounts for each row execute function app.set_updated_at();
create trigger supplier_accounts_set_updated_at before update on app.supplier_accounts for each row execute function app.set_updated_at();

alter table app.parties enable row level security;
alter table app.party_contacts enable row level security;
alter table app.party_addresses enable row level security;
alter table app.customer_accounts enable row level security;
alter table app.supplier_accounts enable row level security;

create policy parties_read on app.parties for select using (app.has_business_permission("businessId", 'party.read'));
create policy parties_write on app.parties for insert with check (app.has_business_permission("businessId", 'party.manage'));
create policy parties_update on app.parties for update using (app.has_business_permission("businessId", 'party.manage')) with check (app.has_business_permission("businessId", 'party.manage'));
create policy party_contacts_read on app.party_contacts for select using (app.has_business_permission("businessId", 'party.read'));
create policy party_contacts_write on app.party_contacts for all using (app.has_business_permission("businessId", 'party.manage')) with check (app.has_business_permission("businessId", 'party.manage'));
create policy party_addresses_read on app.party_addresses for select using (app.has_business_permission("businessId", 'party.read'));
create policy party_addresses_write on app.party_addresses for all using (app.has_business_permission("businessId", 'party.manage')) with check (app.has_business_permission("businessId", 'party.manage'));
create policy customer_accounts_read on app.customer_accounts for select using (app.has_business_permission("businessId", 'party.read'));
create policy customer_accounts_write on app.customer_accounts for all using (app.has_business_permission("businessId", 'party.manage')) with check (app.has_business_permission("businessId", 'party.manage'));
create policy supplier_accounts_read on app.supplier_accounts for select using (app.has_business_permission("businessId", 'party.read'));
create policy supplier_accounts_write on app.supplier_accounts for all using (app.has_business_permission("businessId", 'party.manage')) with check (app.has_business_permission("businessId", 'party.manage'));

grant select, insert, update on app.parties, app.party_contacts, app.party_addresses, app.customer_accounts, app.supplier_accounts to surge_app;

insert into app.permissions ("code", "description") values
  ('party.read', 'View business parties, customers, and suppliers'),
  ('party.manage', 'Manage business parties, customers, and suppliers')
on conflict ("code") do nothing;
insert into app.role_permissions ("roleId", "permissionId")
select role."id", permission."id"
from app.roles role cross join app.permissions permission
where role."businessId" is null and role."code" = 'owner'
  and permission."code" in ('party.read', 'party.manage')
on conflict do nothing;
