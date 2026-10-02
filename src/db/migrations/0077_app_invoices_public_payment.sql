-- 0077_app_invoices_public_payment.sql

create or replace function app.get_public_invoice_payment_target(target_token text)
returns table (
  "invoiceId" uuid,
  "businessId" uuid,
  "orderId" uuid,
  "createdBy" uuid,
  "status" text,
  "currency" text,
  "totalMinor" bigint,
  "balanceDueMinor" bigint,
  "customerEmail" text,
  "customerName" text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
  paid_minor bigint := 0;
  total_minor bigint := 0;
  cust_email text;
  cust_name text;
begin
  select i.* into inv
  from app.invoices i
  where i."publicToken" = target_token and i."status" = 'open'
  limit 1;

  if inv is null or inv."orderId" is null then
    return;
  end if;

  select coalesce(sum(p."amountMinor"), 0) into paid_minor
  from app.payments p
  where p."orderId" = inv."orderId" and p."businessId" = inv."businessId" and p."status" in ('captured', 'authorized');

  total_minor := inv."totalMinor";

  if inv."customerPartyId" is not null then
    select p."displayName" into cust_name
    from app.parties p
    where p."id" = inv."customerPartyId" and p."businessId" = inv."businessId";

    select pc."value" into cust_email
    from app.party_contacts pc
    where pc."partyId" = inv."customerPartyId" and pc."businessId" = inv."businessId" and pc."kind" = 'email' and pc."status" = 'active'
    order by pc."isPrimary" desc, pc."createdAt" limit 1;
  end if;

  return query select
    inv."id",
    inv."businessId",
    inv."orderId",
    inv."createdBy",
    inv."status",
    inv."currency",
    total_minor,
    greatest(0::bigint, total_minor - paid_minor),
    cust_email,
    cust_name;
end;
$$;

revoke all on function app.get_public_invoice_payment_target(text) from public;
grant execute on function app.get_public_invoice_payment_target(text) to scripe_app;

create or replace function app.record_public_invoice_payment(
  target_token text,
  provider_name text,
  provider_ref text,
  idempotency_key text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  inv record;
  paid_minor bigint := 0;
  total_minor bigint := 0;
  balance_due bigint := 0;
  payment_id uuid;
begin
  select i.* into inv
  from app.invoices i
  where i."publicToken" = target_token and i."status" = 'open'
  limit 1;

  if inv is null or inv."orderId" is null then
    raise exception 'Invoice not found or not active';
  end if;

  select coalesce(sum(p."amountMinor"), 0) into paid_minor
  from app.payments p
  where p."orderId" = inv."orderId" and p."businessId" = inv."businessId" and p."status" in ('captured', 'authorized');

  total_minor := inv."totalMinor";
  balance_due := greatest(0::bigint, total_minor - paid_minor);

  if balance_due <= 0 then
    raise exception 'Invoice is already paid in full';
  end if;

  insert into app.payments (
    "businessId", "orderId", "method", "status", "assetCode",
    "amountMinor", "externalReference", "idempotencyKey", "createdBy"
  ) values (
    inv."businessId", inv."orderId", 'online', 'pending',
    inv."currency", balance_due, provider_ref, idempotency_key, inv."createdBy"
  )
  returning "id" into payment_id;

  insert into app.payment_attempts (
    "businessId", "paymentId", "provider", "status", "providerReference"
  ) values (
    inv."businessId", payment_id, provider_name, 'initiated', provider_ref
  );

  return payment_id;
end;
$$;

revoke all on function app.record_public_invoice_payment(text, text, text, text) from public;
grant execute on function app.record_public_invoice_payment(text, text, text, text) to scripe_app;
