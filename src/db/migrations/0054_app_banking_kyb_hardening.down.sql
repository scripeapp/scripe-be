-- Restores the 0052 webhook functions and 0051's free-text document columns.

drop function if exists app.banking_kyb_documents_for_customer(text);
drop policy if exists uploads_platform_compliance_select on app.uploads;
drop policy if exists banking_profiles_platform_update on app.banking_profiles;
drop policy if exists banking_profiles_platform_select on app.banking_profiles;
drop table if exists app.banking_kyc_attempts;
drop index if exists app.banking_profiles_pending_review_idx;

alter table app.banking_profiles
  drop column if exists "providerCustomerType",
  drop column if exists "notificationEmail",
  drop column if exists "dateOfRegistration",
  drop column if exists "directorIdNumber",
  drop column if exists "directorIdDocumentUploadId",
  drop column if exists "certificateOfIncorporationUploadId",
  drop column if exists "statusReportUploadId",
  drop column if exists "proofOfAddressUploadId",
  drop column if exists "kybReviewedBy",
  drop column if exists "kybReviewedAt",
  drop column if exists "kybReviewNotes",
  add column if not exists "directorIdDocumentUrl" text,
  add column if not exists "certificateOfIncorporationUrl" text,
  add column if not exists "statusReportUrl" text,
  add column if not exists "proofOfAddressUrl" text;

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
  returning "businessId", "email", "firstName", coalesce("registeredBusinessName", "firstName" || ' ' || coalesce("lastName", ''))
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

  if new_status = 'active' then
    update app.banking_profiles set "kycStatus" = 'verified', "kycVerifiedAt" = now(), "updatedAt" = now()
      where "businessId" = v_business_id and "kycStatus" <> 'verified';
  end if;

  select "email" into v_email from app.banking_profiles where "businessId" = v_business_id;

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

  select bp."email", coalesce(bp."registeredBusinessName", bp."firstName" || ' ' || coalesce(bp."lastName", ''))
    into v_email, v_business_name
  from app.banking_profiles bp where bp."businessId" = v_business_id;

  return query select true, v_business_id, v_email, v_account_number, v_bank_name, v_business_name;
end;
$$;
revoke all on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) from public;
grant execute on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) to scripe_app;
