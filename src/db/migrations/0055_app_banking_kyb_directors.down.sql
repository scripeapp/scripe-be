-- Restores 0054's single-director and settlement columns (primary director
-- copied back) and its document lookup function.

alter table app.banking_profiles
  add column "directorNin" text,
  add column "directorDob" text,
  add column "directorIdType" text,
  add column "directorIdNumber" text,
  add column "directorIdDocumentUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "settlementBankCode" text,
  add column "settlementAccountNumber" text,
  add column "settlementAccountName" text;

update app.banking_profiles bp set
  "directorDob" = d."dateOfBirth",
  "directorIdType" = d."idType",
  "directorIdNumber" = d."idNumber",
  "directorIdDocumentUploadId" = d."idDocumentUploadId"
from app.banking_kyb_directors d
where d."businessId" = bp."businessId" and d."isPrimary";

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
  left join app.uploads did on did."id" = bp."directorIdDocumentUploadId" and did."status" = 'confirmed'
  where bp."providerCustomerCode" = target_provider_customer_code and bp."providerCustomerType" = 'business';
$$;
revoke all on function app.banking_kyb_documents_for_customer(text) from public;
grant execute on function app.banking_kyb_documents_for_customer(text) to scripe_app;

drop table if exists app.banking_kyb_directors;
