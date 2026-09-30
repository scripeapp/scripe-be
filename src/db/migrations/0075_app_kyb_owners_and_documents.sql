-- Business KYB collects what the verifying provider (Anchor) needs:
--   * the business's own contact email/phone and its CAC-registered address
--     when that differs from where it operates;
--   * every director AND every shareholder owning 5% or more ("people"),
--     each with a role, ownership percentage, job title, nationality and
--     home address, plus the provider's officer id so a resubmission can
--     update the provider's record instead of duplicating it;
--   * documents keyed by the provider's own document type (the list depends
--     on registration type and date), replacing the three fixed columns.

-- 1. Business contact -------------------------------------------------------
alter table app.banking_profiles
  add column "businessEmail" text,
  add column "businessPhone" text,
  add column "registeredAddress" jsonb;

-- 2. People -------------------------------------------------------------------
alter table app.banking_kyb_directors
  add column "role" text not null default 'director' check ("role" in ('director', 'owner', 'director_owner')),
  add column "ownershipPercent" numeric(5, 2) not null default 0 check ("ownershipPercent" between 0 and 100),
  add column "title" text,
  add column "nationality" text not null default 'NG' check ("nationality" ~ '^[A-Z]{2}$'),
  add column "residentialAddress" jsonb;

-- 3. Documents ----------------------------------------------------------------
create table app.banking_kyb_documents (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  -- The provider's document type code, e.g. CERTIFICATE_OF_INCORPORATION.
  "documentType" text not null check ("documentType" ~ '^[A-Z0-9_]{2,60}$'),
  "uploadId" uuid not null references app.uploads ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "documentType")
);

alter table app.banking_kyb_documents enable row level security;
create policy banking_kyb_documents_select on app.banking_kyb_documents for select
  using (app.has_business_permission("businessId", 'banking.read') or app.is_platform_administrator());
create policy banking_kyb_documents_insert on app.banking_kyb_documents for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));
create policy banking_kyb_documents_delete on app.banking_kyb_documents for delete
  using (app.has_business_permission("businessId", 'banking.manage'));
grant select, insert, delete on app.banking_kyb_documents to scripe_app;

insert into app.banking_kyb_documents ("businessId", "documentType", "uploadId")
select "businessId", 'CERTIFICATE_OF_INCORPORATION', "certificateOfIncorporationUploadId" from app.banking_profiles where "certificateOfIncorporationUploadId" is not null
union all
select "businessId", 'CAC_STATUS_REPORT', "statusReportUploadId" from app.banking_profiles where "statusReportUploadId" is not null
union all
select "businessId", 'PROOF_OF_ADDRESS', "proofOfAddressUploadId" from app.banking_profiles where "proofOfAddressUploadId" is not null;

-- The webhook asking for documents (customer.identification.awaitingDocument)
-- has no business principal, so it reads them through this definer function.
drop function if exists app.banking_kyb_documents_for_customer(text);

alter table app.banking_profiles
  drop column "certificateOfIncorporationUploadId",
  drop column "statusReportUploadId",
  drop column "proofOfAddressUploadId";

-- One row per stored document (documentType set) plus one row carrying the
-- business's registration number and TIN (documentType null).
create function app.banking_kyb_documents_for_customer(target_provider_customer_code text)
returns table (
  "businessId" uuid, "registrationNumber" text, "taxIdentificationNumber" text,
  "documentType" text, "objectKey" text, "mimeType" text
)
language sql stable security definer
set search_path = app, pg_temp
as $$
  select bp."businessId", bp."registrationNumber", bp."taxIdentificationNumber", null::text, null::text, null::text
  from app.banking_profiles bp
  where bp."providerCustomerCode" = target_provider_customer_code and bp."providerCustomerType" = 'business'
  union all
  select bp."businessId", bp."registrationNumber", bp."taxIdentificationNumber", document."documentType", upload."objectKey", upload."mimeType"
  from app.banking_profiles bp
  join app.banking_kyb_documents document on document."businessId" = bp."businessId"
  join app.uploads upload on upload."id" = document."uploadId" and upload."status" = 'confirmed'
  where bp."providerCustomerCode" = target_provider_customer_code and bp."providerCustomerType" = 'business';
$$;
revoke all on function app.banking_kyb_documents_for_customer(text) from public;
grant execute on function app.banking_kyb_documents_for_customer(text) to scripe_app;
