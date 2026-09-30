-- Restores the previous (broken) definitions.
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
