-- Fixes "column reference is ambiguous" errors in three webhook-reconciliation
-- functions (0029, 0030). Each `returns table (...)` declares an OUT
-- parameter named after a real column on the table it queries (e.g.
-- "businessId"), and PL/pgSQL treats a later *unqualified* reference to that
-- name as ambiguous between the OUT parameter and the table column — it
-- refuses to run the statement rather than guess. This fails unconditionally,
-- on every call, not just on data-dependent edge cases: every real
-- Paystack/Flutterwave checkout webhook and every Anchor/Brails withdrawal or
-- deposit webhook has been failing since these functions were introduced.
-- Fixed the same way 0036's app.complete_communication_credit_topup avoided
-- it: alias the queried table and qualify every column reference against
-- that alias instead of leaving it bare.

create or replace function app.capture_checkout_payment_from_webhook(target_external_reference text)
returns table ("found" boolean, "captured" boolean, "isFullyPaid" boolean, "businessId" uuid, "orderId" uuid)
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_payment_id uuid;
  v_business_id uuid;
  v_order_id uuid;
  v_amount_minor bigint;
  v_status text;
  v_total_minor bigint;
  v_allocated bigint;
  v_next bigint;
  v_is_fully_paid boolean;
begin
  select payment."id", payment."businessId", payment."orderId", payment."amountMinor", payment."status"
    into v_payment_id, v_business_id, v_order_id, v_amount_minor, v_status
    from app.payments payment where payment."externalReference" = target_external_reference for update;

  if not found then
    return query select false, false, false, null::uuid, null::uuid;
    return;
  end if;

  if v_status <> 'pending' then
    return query select true, false, (v_status = 'captured'), v_business_id, v_order_id;
    return;
  end if;

  select "order"."totalMinor" into v_total_minor from app.orders "order" where "order"."id" = v_order_id and "order"."businessId" = v_business_id for update;

  select coalesce(sum(allocation."amountMinor"), 0) into v_allocated
    from app.payment_allocations allocation where allocation."businessId" = v_business_id and allocation."orderId" = v_order_id;

  insert into app.payment_allocations ("businessId", "paymentId", "orderId", "amountMinor")
    values (v_business_id, v_payment_id, v_order_id, v_amount_minor);

  v_next := v_allocated + v_amount_minor;
  v_is_fully_paid := v_next >= v_total_minor;

  update app.orders "order" set "paymentStatus" = case when v_next >= "order"."totalMinor" then 'paid' else 'partially_paid' end
    where "order"."id" = v_order_id and "order"."businessId" = v_business_id;

  update app.payments set "status" = 'captured' where "id" = v_payment_id;

  return query select true, true, v_is_fully_paid, v_business_id, v_order_id;
end;
$$;

revoke all on function app.capture_checkout_payment_from_webhook(text) from public;
grant execute on function app.capture_checkout_payment_from_webhook(text) to surge_app;

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
grant execute on function app.mark_withdrawal_status_from_webhook(text, text, text) to surge_app;

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
