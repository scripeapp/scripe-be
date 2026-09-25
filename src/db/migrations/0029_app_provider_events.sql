-- Provider-events: webhook ingestion for Paystack, Flutterwave, Anchor, and
-- Brails. A webhook carries no authenticated user, so the tables it needs
-- to update (payments, banking) stay RLS-gated by real business membership
-- as normal — these narrow SECURITY DEFINER functions are the sanctioned
-- bypass, the same pattern this codebase already uses for
-- app.create_business_with_default_store and app.has_business_permission.
-- Payment capture and banking-status updates are auto-applied here.
-- Withdrawal/transfer reconciliation, wallet-deposit crediting, and
-- receipt auto-issuance are handled by the follow-up functions in
-- migration 0030 (they were deferred out of this migration initially,
-- then resolved in that pass).

create table app.provider_events (
  "id" uuid primary key default gen_random_uuid(),
  "provider" text not null check ("provider" in ('paystack', 'flutterwave', 'anchor', 'brails')),
  "eventType" text not null,
  "providerReference" text,
  "signatureValid" boolean not null,
  "status" text not null default 'received' check ("status" in ('received', 'processed', 'ignored', 'failed')),
  "payload" jsonb not null check (jsonb_typeof("payload") = 'object'),
  "errorMessage" text,
  "receivedAt" timestamptz not null default now(),
  "processedAt" timestamptz
);

-- A provider redelivering the same event must never be processed twice.
-- Nullable providerReference (some events carry none) sits outside this
-- constraint rather than colliding on repeated nulls.
create unique index provider_events_dedupe_idx on app.provider_events ("provider", "eventType", "providerReference") where "providerReference" is not null;
create index provider_events_provider_idx on app.provider_events ("provider", "receivedAt" desc);

-- No RLS: this is a system-written audit/idempotency log with no HTTP read
-- endpoint in this pass (no platform-admin authority concept exists yet to
-- gate one against), not a business-facing resource.
grant select, insert, update on app.provider_events to scripe_app;

-- Captures a payment left "pending" by payments.service.initiateCheckout,
-- mirroring payments.repository.ts's allocate()/captureCheckoutPayment()
-- exactly — keep both in sync if that logic changes. A webhook has no
-- business-scoped read access under RLS, so this looks the payment up
-- itself by its externalReference (the same string initiateCheckout
-- generated and handed to the gateway) rather than requiring a caller-side
-- lookup first. found = false covers both "no matching payment" (not ours,
-- or a stale/malformed reference) and an already-resolved payment —
-- idempotent against redelivery either way.
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
  select "id", "businessId", "orderId", "amountMinor", "status"
    into v_payment_id, v_business_id, v_order_id, v_amount_minor, v_status
    from app.payments where "externalReference" = target_external_reference for update;

  if not found then
    return query select false, false, false, null::uuid, null::uuid;
    return;
  end if;

  if v_status <> 'pending' then
    return query select true, false, (v_status = 'captured'), v_business_id, v_order_id;
    return;
  end if;

  select "totalMinor" into v_total_minor from app.orders where "id" = v_order_id and "businessId" = v_business_id for update;

  select coalesce(sum("amountMinor"), 0) into v_allocated
    from app.payment_allocations where "businessId" = v_business_id and "orderId" = v_order_id;

  insert into app.payment_allocations ("businessId", "paymentId", "orderId", "amountMinor")
    values (v_business_id, v_payment_id, v_order_id, v_amount_minor);

  v_next := v_allocated + v_amount_minor;
  v_is_fully_paid := v_next >= v_total_minor;

  update app.orders set "paymentStatus" = case when v_next >= "totalMinor" then 'paid' else 'partially_paid' end
    where "id" = v_order_id and "businessId" = v_business_id;

  update app.payments set "status" = 'captured' where "id" = v_payment_id;

  return query select true, true, v_is_fully_paid, v_business_id, v_order_id;
end;
$$;

revoke all on function app.capture_checkout_payment_from_webhook(text) from public;
grant execute on function app.capture_checkout_payment_from_webhook(text) to scripe_app;

-- Marks a payment (still pending) as failed once its gateway confirms the
-- charge failed — the counterpart to capture, for the "failed" branch.
-- Returns whether a matching pending payment was actually found and
-- updated (false for an already-resolved or unknown reference).
create or replace function app.fail_checkout_payment_from_webhook(target_external_reference text)
returns boolean
language sql volatile security definer
set search_path = app, pg_temp
as $$
  with updated as (
    update app.payments set "status" = 'failed'
      where "externalReference" = target_external_reference and "status" = 'pending'
    returning 1
  )
  select exists (select 1 from updated);
$$;

revoke all on function app.fail_checkout_payment_from_webhook(text) from public;
grant execute on function app.fail_checkout_payment_from_webhook(text) to scripe_app;

-- The webhook only carries the provider's own customer id, not our
-- internal businessId (which itself sits behind RLS) — looked up here by
-- providerCustomerCode rather than requiring the caller to resolve it
-- first.
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
grant execute on function app.mark_banking_kyc_status_from_webhook(text, text, text) to scripe_app;

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
grant execute on function app.mark_virtual_account_status_from_webhook(text, text, text, text, text) to scripe_app;
