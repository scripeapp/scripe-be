-- Restores the narrower signatures from 0029 and 0037.

drop function if exists app.mark_banking_kyc_status_from_webhook(text, text, text);
create or replace function app.mark_banking_kyc_status_from_webhook(target_provider_customer_code text, new_status text, failure_reason text)
returns boolean
language sql volatile security definer
set search_path = app, pg_temp
as $$
  with updated as (
    update app.banking_profiles set
      "kycStatus" = new_status,
      "kycFailureReason" = failure_reason,
      "kycVerifiedAt" = case when new_status = 'verified' then now() else "kycVerifiedAt" end,
      "updatedAt" = now()
    where "providerCustomerCode" = target_provider_customer_code
    returning 1
  )
  select exists (select 1 from updated);
$$;
revoke all on function app.mark_banking_kyc_status_from_webhook(text, text, text) from public;
grant execute on function app.mark_banking_kyc_status_from_webhook(text, text, text) to surge_app;

drop function if exists app.mark_virtual_account_status_from_webhook(text, text, text, text, text);
create or replace function app.mark_virtual_account_status_from_webhook(
  target_provider_account_id text, new_status text, new_account_number text, new_account_name text, new_bank_name text
)
returns boolean
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
begin
  update app.virtual_accounts set
    "status" = new_status,
    "accountNumber" = coalesce(new_account_number, "accountNumber"),
    "accountName" = coalesce(new_account_name, "accountName"),
    "bankName" = coalesce(new_bank_name, "bankName"),
    "updatedAt" = now()
  where "providerAccountId" = target_provider_account_id
  returning "businessId" into v_business_id;

  if v_business_id is not null and new_status = 'active' then
    update app.banking_profiles set "kycStatus" = 'verified', "kycVerifiedAt" = now(), "updatedAt" = now()
      where "businessId" = v_business_id and "kycStatus" <> 'verified';
  end if;

  return v_business_id is not null;
end;
$$;
revoke all on function app.mark_virtual_account_status_from_webhook(text, text, text, text, text) from public;
grant execute on function app.mark_virtual_account_status_from_webhook(text, text, text, text, text) to surge_app;

drop function if exists app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text);
create or replace function app.record_wallet_deposit_from_webhook(
  target_provider text, target_provider_account_id text, target_provider_reference text, amount_minor bigint, asset_code text, description text
)
returns table ("found" boolean, "businessId" uuid)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_business_id uuid;
begin
  select account."businessId" into v_business_id from app.virtual_accounts account where account."providerAccountId" = target_provider_account_id;
  if v_business_id is null then
    return query select false, null::uuid;
    return;
  end if;

  insert into app.wallet_transactions ("businessId", "type", "direction", "status", "assetCode", "amountMinor", "provider", "providerReference", "description", "postedAt")
  values (v_business_id, 'deposit', 'credit', 'posted', asset_code, amount_minor, target_provider, target_provider_reference, description, now())
  on conflict ("provider", "providerReference") do nothing;

  return query select true, v_business_id;
end;
$$;
revoke all on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) from public;
grant execute on function app.record_wallet_deposit_from_webhook(text, text, text, bigint, text, text) to surge_app;
