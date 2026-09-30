-- Transfers created from bills.
--
-- "Confirm payment" on a bill creates a wallet withdrawal to the vendor's
-- bank account, tied to the bill. It reuses what withdrawals already have
-- (balance hold, KYC, the provider call and the webhook that settles it),
-- but it never goes out by itself: it always waits for approval under the
-- Bills workflow, or the business owners when there is none. The bill only
-- counts as paid once the provider confirms the transfer succeeded
-- (app.settle_bill_withdrawal). "Record payment" (money paid outside
-- Scripe) keeps writing an allocation directly, as before.

alter table app.withdrawals
  add column "purpose" text not null default 'withdrawal' check ("purpose" in ('withdrawal', 'bill_payment')),
  add column "billId" uuid references app.bills ("id") on delete restrict,
  add constraint withdrawals_bill_purpose_check check (("purpose" = 'bill_payment') = ("billId" is not null));

create index withdrawals_bill_idx on app.withdrawals ("billId") where "billId" is not null;

-- Records a succeeded bill-payment withdrawal against its bill: one
-- allocation (keyed by the withdrawal's reference, so a repeat call is a
-- no-op), the bill's paid amount and status, and the journal entry that
-- settles the payable. Safe to call for any withdrawal; it does nothing
-- unless the withdrawal paid a bill and has succeeded.
create or replace function app.settle_bill_withdrawal(target_withdrawal_id uuid)
returns boolean
language plpgsql volatile security definer
set search_path = app, pg_temp
as $$
declare
  v_withdrawal app.withdrawals%rowtype;
  v_created_by uuid;
  v_allocation_id uuid;
begin
  select * into v_withdrawal from app.withdrawals where "id" = target_withdrawal_id;
  if not found or v_withdrawal."billId" is null or v_withdrawal."status" <> 'success' then
    return false;
  end if;

  select coalesce(v_withdrawal."requestedBy", bill."createdBy") into v_created_by
    from app.bills bill where bill."id" = v_withdrawal."billId";

  insert into app.bill_payment_allocations ("businessId", "billId", "paymentReference", "amountMinor", "assetCode", "paidAt", "createdBy")
  select v_withdrawal."businessId", bill."id", v_withdrawal."providerReference", v_withdrawal."amountMinor", v_withdrawal."assetCode", now(), v_created_by
    from app.bills bill
   where bill."id" = v_withdrawal."billId"
     and bill."businessId" = v_withdrawal."businessId"
     and bill."status" <> 'voided'
     and bill."amountPaidMinor" + v_withdrawal."amountMinor" <= bill."totalMinor"
  on conflict ("businessId", "paymentReference", "billId") do nothing
  returning "id" into v_allocation_id;

  if v_allocation_id is null then
    return false;
  end if;

  update app.bills set
    "amountPaidMinor" = "amountPaidMinor" + v_withdrawal."amountMinor",
    "status" = case when "amountPaidMinor" + v_withdrawal."amountMinor" = "totalMinor" then 'paid' else 'partially_paid' end
  where "id" = v_withdrawal."billId" and "businessId" = v_withdrawal."businessId";

  perform app.post_journal_entry(
    v_withdrawal."businessId", current_date, 'Bill paid by transfer', 'bill_payment_allocation', v_allocation_id::text,
    null, v_created_by,
    jsonb_build_array(
      jsonb_build_object('accountCode', 'accounts_payable', 'direction', 'debit', 'amountMinor', v_withdrawal."amountMinor"::text, 'assetCode', v_withdrawal."assetCode"),
      jsonb_build_object('accountCode', 'bank', 'direction', 'credit', 'amountMinor', v_withdrawal."amountMinor"::text, 'assetCode', v_withdrawal."assetCode")
    )
  );
  return true;
end;
$$;
revoke all on function app.settle_bill_withdrawal(uuid) from public;
grant execute on function app.settle_bill_withdrawal(uuid) to scripe_app;

-- Same as 0037's version, plus settling the bill when a bill payment
-- succeeds.
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
    perform app.settle_bill_withdrawal(v_id);
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

-- The owners who approve a bill transfer when the business has no Bills
-- workflow. Whoever raises the transfer may not be able to read other
-- members, so this answers only for someone allowed to raise one.
create or replace function app.business_owner_approvers(target_business_id uuid)
returns table ("userId" uuid, "email" text, "name" text)
language sql stable security definer
set search_path = app, pg_temp
as $$
  select membership."userId", "user"."email", coalesce(nullif(trim("user"."name"), ''), "user"."email")
    from app.business_memberships membership
    join auth.user "user" on "user"."id" = membership."userId"
   where membership."businessId" = target_business_id
     and membership."status" = 'active'
     and app.has_business_permission(target_business_id, 'payables.manage')
     and exists (
       select 1 from app.membership_roles membership_role
       join app.roles role on role."id" = membership_role."roleId"
       where membership_role."membershipId" = membership."id" and role."code" = 'owner'
     )
   order by membership."createdAt";
$$;
revoke all on function app.business_owner_approvers(uuid) from public;
grant execute on function app.business_owner_approvers(uuid) to scripe_app;
