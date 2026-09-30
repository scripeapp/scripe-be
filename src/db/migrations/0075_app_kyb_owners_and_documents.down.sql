drop function if exists app.banking_kyb_documents_for_customer(text);

alter table app.banking_profiles
  add column "certificateOfIncorporationUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "statusReportUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "proofOfAddressUploadId" uuid references app.uploads ("id") on delete restrict;

update app.banking_profiles bp set
  "certificateOfIncorporationUploadId" = (select d."uploadId" from app.banking_kyb_documents d where d."businessId" = bp."businessId" and d."documentType" = 'CERTIFICATE_OF_INCORPORATION'),
  "statusReportUploadId" = (select d."uploadId" from app.banking_kyb_documents d where d."businessId" = bp."businessId" and d."documentType" = 'CAC_STATUS_REPORT'),
  "proofOfAddressUploadId" = (select d."uploadId" from app.banking_kyb_documents d where d."businessId" = bp."businessId" and d."documentType" = 'PROOF_OF_ADDRESS');

drop table app.banking_kyb_documents;

alter table app.banking_kyb_directors
  drop column "residentialAddress",
  drop column "nationality",
  drop column "title",
  drop column "ownershipPercent",
  drop column "role";

alter table app.banking_profiles
  drop column "registeredAddress",
  drop column "businessPhone",
  drop column "businessEmail";

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
