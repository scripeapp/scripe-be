-- Resolves the three items migration 0029 deliberately deferred: withdrawal
-- /transfer reconciliation, wallet-deposit crediting, and receipt
-- auto-issuance on webhook-confirmed payments. Same SECURITY DEFINER
-- pattern as 0029 — narrow, single-purpose functions, each mirroring the
-- equivalent TS logic (banking.service.finalizeWithdrawal,
-- banking.repository.postWalletTransaction, receipts.repository.issueReceipt)
-- exactly, so keep both in sync if that logic changes.

-- A webhook-issued receipt has no real user behind it — nullable rather
-- than inventing a fake "system" auth.user row, which would need its own
-- reasoning about a schema Better Auth owns.
alter table app.fiscal_documents alter column "createdBy" drop not null;

create or replace function app.issue_receipt_from_webhook(target_business_id uuid, target_order_id uuid)
returns uuid
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_currency text;
  v_subtotal_minor bigint;
  v_tax_minor bigint;
  v_total_minor bigint;
  v_sequence bigint;
  v_number text;
  v_id uuid;
begin
  perform 1 from app.businesses where "id" = target_business_id for update;

  select "currency", "subtotalMinor", "taxMinor", "totalMinor"
    into v_currency, v_subtotal_minor, v_tax_minor, v_total_minor
    from app.orders where "id" = target_order_id and "businessId" = target_business_id;
  if not found then
    return null;
  end if;

  select coalesce(max("sequence"), 0) + 1 into v_sequence from app.fiscal_documents where "businessId" = target_business_id;
  v_number := 'RCT-' || lpad(v_sequence::text, 6, '0');

  insert into app.fiscal_documents (
    "businessId", "orderId", "kind", "sequence", "number", "currency", "subtotalMinor", "taxMinor", "totalMinor", "createdBy"
  ) values (
    target_business_id, target_order_id, 'receipt', v_sequence, v_number, v_currency, v_subtotal_minor, v_tax_minor, v_total_minor, null
  )
  on conflict do nothing
  returning "id" into v_id;

  return v_id;
end;
$$;

revoke all on function app.issue_receipt_from_webhook(uuid, uuid) from public;
grant execute on function app.issue_receipt_from_webhook(uuid, uuid) to surge_app;

-- Reconciles a withdrawal once its transfer's final status is known,
-- mirroring banking.service.ts's finalizeWithdrawal: posts the pending
-- ledger debit on success, or inserts a reversal credit on failure.
-- Looked up by providerTransferCode — the provider's own transfer id,
-- which is what a transfer webhook actually carries, not our internal
-- providerReference. Idempotent: a withdrawal already in a terminal state
-- ('success' or 'failed') is left untouched and reported found = true.
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
  select "id", "businessId", "providerReference", "assetCode", "amountMinor", "status"
    into v_id, v_business_id, v_provider_reference, v_asset_code, v_amount_minor, v_current_status
    from app.withdrawals where "providerTransferCode" = target_provider_transfer_code for update;

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

  select "provider" into v_wallet_provider from app.wallet_transactions where "providerReference" = v_provider_reference limit 1;

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
grant execute on function app.mark_withdrawal_status_from_webhook(text, text, text) to surge_app;

-- Credits the wallet ledger for an inbound virtual-account deposit.
-- Idempotent via wallet_transactions' existing unique(provider,
-- providerReference) index — a redelivered deposit webhook is a no-op.
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
  select "businessId" into v_business_id from app.virtual_accounts where "providerAccountId" = target_provider_account_id;
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
