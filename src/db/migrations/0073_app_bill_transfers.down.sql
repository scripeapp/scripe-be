-- Restores 0037's webhook function and removes bill-linked withdrawals.
drop function if exists app.business_owner_approvers(uuid);
drop function if exists app.settle_bill_withdrawal(uuid);

create or replace function app.mark_withdrawal_status_from_webhook(target_provider_transfer_code text, new_status text, failure_reason text)
returns table ("found" boolean, "businessId" uuid)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_id uuid;
  v_business_id uuid;
  v_provider_reference text;
  v_asset_code text;
  v_amount_minor bigint;
  v_current_status text;
  v_wallet_provider text;
begin
  select withdrawal."id", withdrawal."businessId", withdrawal."providerReference", withdrawal."assetCode", withdrawal."amountMinor", withdrawal."status"
    into v_id, v_business_id, v_provider_reference, v_asset_code, v_amount_minor, v_current_status
    from app.withdrawals withdrawal where withdrawal."providerTransferCode" = target_provider_transfer_code for update;

  if not found then
    return query select false, null::uuid;
    return;
  end if;

  if v_current_status in ('success', 'failed') then
    return query select true, v_business_id;
    return;
  end if;

  update app.withdrawals set
    "status" = new_status,
    "failureReason" = case when new_status = 'failed' then failure_reason else "failureReason" end,
    "updatedAt" = now()
  where "id" = v_id;

  select "transaction"."provider" into v_wallet_provider from app.wallet_transactions "transaction" where "transaction"."providerReference" = v_provider_reference limit 1;

  if new_status = 'success' then
    update app.wallet_transactions set "status" = 'posted', "postedAt" = now() where "providerReference" = v_provider_reference;
  elsif new_status = 'failed' then
    insert into app.wallet_transactions ("businessId", "type", "direction", "status", "assetCode", "amountMinor", "provider", "providerReference", "description", "postedAt")
    values (v_business_id, 'reversal', 'credit', 'posted', v_asset_code, v_amount_minor, coalesce(v_wallet_provider, 'unknown'), v_provider_reference || ':reversal', 'Withdrawal reversal', now())
    on conflict ("provider", "providerReference") do nothing;
  end if;

  return query select true, v_business_id;
end;
$$;

revoke all on function app.mark_withdrawal_status_from_webhook(text, text, text) from public;
grant execute on function app.mark_withdrawal_status_from_webhook(text, text, text) to scripe_app;

drop index if exists app.withdrawals_bill_idx;
alter table app.withdrawals drop constraint if exists withdrawals_bill_purpose_check, drop column "billId", drop column "purpose";
