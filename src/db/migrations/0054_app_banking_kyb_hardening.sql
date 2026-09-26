-- Closes the gaps found reviewing corporate KYB (0051/0052):
--   * documents are real, business-scoped confirmed uploads, not free-text
--     "URLs" (the frontend was sending bare file names);
--   * the provider customer's type is tracked, so an individual customer
--     code is never reused to open a business account (or vice versa);
--   * banking emails go to the submitting user's verified account email,
--     never to an unverified address typed into the form;
--   * a business profile only reaches "verified" through the provider's KYB
--     decision (Anchor webhook) or a platform administrator's review
--     (Brails, which only validates the director's BVN) — an issued virtual
--     account no longer promotes a business profile to verified by itself;
--   * submissions are rate limited per business;
--   * BVN/NIN/date of birth are written encrypted by the application
--     (shared/pii-crypto.ts) — existing plain-text rows stay readable.

alter table app.banking_profiles
  add column "providerCustomerType" text check ("providerCustomerType" in ('individual', 'business')),
  add column "notificationEmail" text,
  add column "dateOfRegistration" date,
  add column "directorIdNumber" text,
  add column "directorIdDocumentUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "certificateOfIncorporationUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "statusReportUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "proofOfAddressUploadId" uuid references app.uploads ("id") on delete restrict,
  add column "kybReviewedBy" uuid references auth.user ("id") on delete restrict,
  add column "kybReviewedAt" timestamptz,
  add column "kybReviewNotes" text,
  -- 0051 stored whatever string the client sent (in practice, a file name).
  -- Nothing ever pointed at real storage, so there is nothing to migrate.
  drop column if exists "directorIdDocumentUrl",
  drop column if exists "certificateOfIncorporationUrl",
  drop column if exists "statusReportUrl",
  drop column if exists "proofOfAddressUrl";

update app.banking_profiles set "providerCustomerType" = case
    when "registeredBusinessName" is not null then 'business'
    else 'individual'
  end
where "providerCustomerCode" is not null;

create index banking_profiles_pending_review_idx on app.banking_profiles ("kycSubmittedAt")
  where "kycStatus" = 'pending' and "providerCustomerType" = 'business';

-- Written in its own committed transaction before any provider call, so a
-- submission that later fails still counts toward the limit.
create table app.banking_kyc_attempts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "userId" uuid not null references auth.user ("id") on delete restrict,
  "kind" text not null check ("kind" in ('individual', 'business')),
  "createdAt" timestamptz not null default now()
);
create index banking_kyc_attempts_business_idx on app.banking_kyc_attempts ("businessId", "createdAt" desc);
alter table app.banking_kyc_attempts enable row level security;
create policy banking_kyc_attempts_select on app.banking_kyc_attempts for select
  using (app.has_business_permission("businessId", 'banking.manage'));
create policy banking_kyc_attempts_insert on app.banking_kyc_attempts for insert
  with check (app.has_business_permission("businessId", 'banking.manage') and "userId"::text = app.current_user_id());
grant select, insert on app.banking_kyc_attempts to scripe_app;

-- Platform administrators review business submissions across tenants. The
-- minimum administrator role is enforced by the service; RLS only admits
-- active administrators at all.
create policy banking_profiles_platform_select on app.banking_profiles for select
  using (app.is_platform_administrator());
create policy banking_profiles_platform_update on app.banking_profiles for update
  using (app.is_platform_administrator())
  with check (app.is_platform_administrator());
create policy uploads_platform_compliance_select on app.uploads for select
  using ("purpose" = 'compliance_document' and app.is_platform_administrator());

-- Webhook reconciliation: notify the verified submitter, not the typed-in
-- director email.
drop function if exists app.mark_banking_kyc_status_from_webhook(text, text, text);
create or replace function app.mark_banking_kyc_status_from_webhook(target_provider_customer_code text, new_status text, failure_reason text)
returns table ("found" boolean, "businessId" uuid, "email" text, "firstName" text, "businessName" text)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
  v_email text;
  v_first_name text;
  v_business_name text;
begin
  update app.banking_profiles set
    "kycStatus" = new_status,
    "kycFailureReason" = failure_reason,
    "kycVerifiedAt" = case when new_status = 'verified' then now() else "kycVerifiedAt" end,
    "updatedAt" = now()
  where "providerCustomerCode" = target_provider_customer_code
  returning "businessId", "notificationEmail", "firstName", coalesce("registeredBusinessName", "firstName" || ' ' || coalesce("lastName", ''))
    into v_business_id, v_email, v_first_name, v_business_name;

  if not found then
    return query select false, null::uuid, null::text, null::text, null::text;
    return;
  end if;

  return query select true, v_business_id, v_email, v_first_name, v_business_name;
end;
$$;
revoke all on function app.mark_banking_kyc_status_from_webhook(text, text, text) from public;
grant execute on function app.mark_banking_kyc_status_from_webhook(text, text, text) to scripe_app;

drop function if exists app.mark_virtual_account_status_from_webhook(text, text, text, text, text);
create or replace function app.mark_virtual_account_status_from_webhook(
  target_provider_account_id text, new_status text, new_account_number text, new_account_name text, new_bank_name text
)
returns table ("found" boolean, "businessId" uuid, "email" text, "accountNumber" text, "accountName" text, "bankName" text)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
  v_account_number text;
  v_account_name text;
  v_bank_name text;
  v_email text;
begin
  update app.virtual_accounts set
    "status" = new_status,
    "accountNumber" = coalesce(new_account_number, "accountNumber"),
    "accountName" = coalesce(new_account_name, "accountName"),
    "bankName" = coalesce(new_bank_name, "bankName"),
    "updatedAt" = now()
  where "providerAccountId" = target_provider_account_id
  returning "businessId", "accountNumber", "accountName", "bankName"
    into v_business_id, v_account_number, v_account_name, v_bank_name;

  if not found then
    return query select false, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  -- An issued account proves the provider accepted an individual's BVN,
  -- but says nothing about whether a business is real — business profiles
  -- are only verified by KYB review.
  if new_status = 'active' then
    update app.banking_profiles set "kycStatus" = 'verified', "kycVerifiedAt" = now(), "updatedAt" = now()
      where "businessId" = v_business_id and "kycStatus" <> 'verified'
        and coalesce("providerCustomerType", 'individual') = 'individual';
  end if;

  select "notificationEmail" into v_email from app.banking_profiles where "businessId" = v_business_id;

  return query select true, v_business_id, v_email, v_account_number, v_account_name, v_bank_name;
end;
$$;
revoke all on function app.mark_virtual_account_status_from_webhook(text, text, text, text, text) from public;
grant execute on function app.mark_virtual_account_status_from_webhook(text, text, text, text, text) to scripe_app;

drop function if exists app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text);
create or replace function app.record_wallet_deposit_from_webhook(
  target_provider text, target_provider_account_id text, target_provider_reference text, amount_minor bigint, asset_code text, description text
)
returns table ("found" boolean, "businessId" uuid, "email" text, "accountNumber" text, "bankName" text, "businessName" text)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
  v_account_number text;
  v_bank_name text;
  v_email text;
  v_business_name text;
begin
  select account."businessId", account."accountNumber", account."bankName"
    into v_business_id, v_account_number, v_bank_name
  from app.virtual_accounts account where account."providerAccountId" = target_provider_account_id;

  if v_business_id is null then
    return query select false, null::uuid, null::text, null::text, null::text, null::text;
    return;
  end if;

  insert into app.wallet_transactions ("businessId", "type", "direction", "status", "assetCode", "amountMinor", "provider", "providerReference", "description", "postedAt")
  values (v_business_id, 'deposit', 'credit', 'posted', asset_code, amount_minor, target_provider, target_provider_reference, description, now())
  on conflict ("provider", "providerReference") do nothing;

  select bp."notificationEmail", coalesce(bp."registeredBusinessName", bp."firstName" || ' ' || coalesce(bp."lastName", ''))
    into v_email, v_business_name
  from app.banking_profiles bp where bp."businessId" = v_business_id;

  return query select true, v_business_id, v_email, v_account_number, v_bank_name, v_business_name;
end;
$$;
revoke all on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) from public;
grant execute on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) to scripe_app;

-- Anchor asks for KYB documents asynchronously
-- (customer.identification.awaitingDocument); the webhook runs without a
-- business principal, so it resolves the stored upload keys through here.
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
