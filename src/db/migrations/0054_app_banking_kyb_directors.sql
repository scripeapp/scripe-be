-- Corporate KYB now takes any number of directors, one of whom is the
-- primary signatory (their BVN and contact details open the account), and
-- no longer collects a settlement account — neither Anchor nor Brails uses
-- one for identity verification, and payout accounts are chosen per
-- withdrawal.

create table app.banking_kyb_directors (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "position" integer not null check ("position" >= 0),
  "isPrimary" boolean not null default false,
  "fullName" text not null check (length(trim("fullName")) between 1 and 255),
  "firstName" text not null,
  "middleName" text,
  "lastName" text not null,
  "email" text not null,
  "phone" text not null,
  -- bvn, dateOfBirth and idNumber are encrypted by the application
  -- (shared/pii-crypto.ts).
  "bvn" text not null,
  "dateOfBirth" text not null,
  "idType" text not null check ("idType" in ('nin', 'passport', 'drivers_license', 'voters_card')),
  "idNumber" text not null,
  "idDocumentUploadId" uuid not null references app.uploads ("id") on delete restrict,
  "createdAt" timestamptz not null default now(),
  unique ("businessId", "position")
);
create unique index banking_kyb_directors_one_primary_idx on app.banking_kyb_directors ("businessId") where "isPrimary";

alter table app.banking_kyb_directors enable row level security;
create policy banking_kyb_directors_select on app.banking_kyb_directors for select
  using (app.has_business_permission("businessId", 'banking.read') or app.is_platform_administrator());
create policy banking_kyb_directors_insert on app.banking_kyb_directors for insert
  with check (app.has_business_permission("businessId", 'banking.manage'));
create policy banking_kyb_directors_delete on app.banking_kyb_directors for delete
  using (app.has_business_permission("businessId", 'banking.manage'));
grant select, insert, delete on app.banking_kyb_directors to scripe_app;

-- Carry any existing single-director submission over as that business's
-- primary director.
insert into app.banking_kyb_directors (
  "businessId", "position", "isPrimary", "fullName", "firstName", "lastName", "email", "phone",
  "bvn", "dateOfBirth", "idType", "idNumber", "idDocumentUploadId"
)
select "businessId", 0, true, trim("firstName" || ' ' || "lastName"), "firstName", "lastName", "email", "phone",
  "bvn", "directorDob", "directorIdType", "directorIdNumber", "directorIdDocumentUploadId"
from app.banking_profiles
where "providerCustomerType" = 'business'
  and "directorIdDocumentUploadId" is not null and "directorIdNumber" is not null and "directorDob" is not null
  and "firstName" is not null and "lastName" is not null and "email" is not null and "phone" is not null and "bvn" is not null;

alter table app.banking_profiles
  drop column "directorNin",
  drop column "directorDob",
  drop column "directorIdType",
  drop column "directorIdNumber",
  drop column "directorIdDocumentUploadId",
  drop column "settlementBankCode",
  drop column "settlementAccountNumber",
  drop column "settlementAccountName";

-- The ID Anchor may request with the business's KYB documents is the
-- primary director's.
drop function if exists app.banking_kyb_documents_for_customer(text);
create or replace function app.banking_kyb_documents_for_customer(target_provider_customer_code text)
returns table (
  "businessId" uuid, "registrationNumber" text, "taxIdentificationNumber" text,
  "certificateOfIncorporationKey" text, "certificateOfIncorporationMimeType" text,
  "statusReportKey" text, "statusReportMimeType" text,
  "proofOfAddressKey" text, "proofOfAddressMimeType" text,
  "directorIdDocumentKey" text, "directorIdDocumentMimeType" text
)
language sql stable security definer
set search_path = app, pg_temp
as $$
  select bp."businessId", bp."registrationNumber", bp."taxIdentificationNumber",
    coi."objectKey", coi."mimeType", sr."objectKey", sr."mimeType",
    poa."objectKey", poa."mimeType", did."objectKey", did."mimeType"
  from app.banking_profiles bp
  left join app.uploads coi on coi."id" = bp."certificateOfIncorporationUploadId" and coi."status" = 'confirmed'
  left join app.uploads sr on sr."id" = bp."statusReportUploadId" and sr."status" = 'confirmed'
  left join app.uploads poa on poa."id" = bp."proofOfAddressUploadId" and poa."status" = 'confirmed'
  left join app.banking_kyb_directors primary_director on primary_director."businessId" = bp."businessId" and primary_director."isPrimary"
  left join app.uploads did on did."id" = primary_director."idDocumentUploadId" and did."status" = 'confirmed'
  where bp."providerCustomerCode" = target_provider_customer_code and bp."providerCustomerType" = 'business';
$$;
revoke all on function app.banking_kyb_documents_for_customer(text) from public;
grant execute on function app.banking_kyb_documents_for_customer(text) to scripe_app;
