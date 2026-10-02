-- 0083_app_checkout_settlement.sql
-- Part 1: settlement. Every online checkout used to collect into Scripe's
-- own Paystack balance with nothing paying the business. Each business now
-- gets a Paystack subaccount whose settlement account is its own active
-- virtual account (the business account banking already issues), and
-- checkouts for that business's sales pass the subaccount so Paystack
-- settles to the business directly. Fee bearer is the subaccount and there
-- is no platform charge in v1 (no fee decision has been made yet).
--
-- Part 2: invoices. Closes the loop between customer and merchant:
--   * "transferReportedAt": the customer says they paid by bank transfer.
--     The merchant is told (email + in-app) and records the payment once it
--     arrives. The report itself never marks anything paid.
--   * get_invoice_payment_notification: what the "payment received" emails
--     and in-app notification need, readable from the webhook path (no user).


-- ---------------------------------------------------------------------------
-- Part 1: checkout subaccounts
-- ---------------------------------------------------------------------------

create table app.checkout_subaccounts (
  "id" uuid primary key default gen_random_uuid(),
  "businessId" uuid not null references app.businesses ("id") on delete restrict,
  "provider" text not null default 'paystack' check ("provider" in ('paystack')),
  "subaccountCode" text not null,
  "virtualAccountId" uuid references app.virtual_accounts ("id") on delete restrict,
  "settlementBankCode" text not null,
  "settlementAccountNumber" text not null check ("settlementAccountNumber" ~ '^[0-9]{10}$'),
  "settlementAccountName" text,
  "status" text not null default 'active' check ("status" in ('active', 'retired')),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

-- One live subaccount per business and provider; a changed business account retires the old one.
create unique index checkout_subaccounts_one_active on app.checkout_subaccounts ("businessId", "provider") where "status" = 'active';
create trigger checkout_subaccounts_set_updated_at before update on app.checkout_subaccounts
  for each row execute function app.set_updated_at();

alter table app.checkout_subaccounts enable row level security;
create policy checkout_subaccounts_read on app.checkout_subaccounts for select
  using (app.has_business_permission("businessId", 'payment.read'));
grant select on app.checkout_subaccounts to scripe_app;

-- What checkout needs to settle to a business, readable with or without a
-- signed-in user (public invoice and paylink checkouts are anonymous):
-- the business's active virtual account, and the active subaccount if it
-- still points at that same account.
create function app.get_checkout_settlement_target(target_business_id uuid)
returns table (
  "businessName" text,
  "virtualAccountId" uuid,
  "bankName" text,
  "bankSlug" text,
  "accountNumber" text,
  "accountName" text,
  "subaccountCode" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    b."displayName",
    va."id",
    va."bankName",
    va."bankSlug",
    va."accountNumber",
    va."accountName",
    (select cs."subaccountCode" from app.checkout_subaccounts cs
      where cs."businessId" = b."id" and cs."provider" = 'paystack' and cs."status" = 'active'
        and cs."virtualAccountId" = va."id" and cs."settlementAccountNumber" = va."accountNumber"
      limit 1)
  from app.businesses b
  left join lateral (
    select v.* from app.virtual_accounts v
    where v."businessId" = b."id" and v."status" = 'active' and v."accountNumber" is not null
    order by v."createdAt" desc limit 1
  ) va on true
  where b."id" = target_business_id;
$$;

revoke all on function app.get_checkout_settlement_target(uuid) from public;
grant execute on function app.get_checkout_settlement_target(uuid) to scripe_app;

-- Saves a subaccount the provider just created for the business's current
-- virtual account, retiring any earlier one. Only called by
-- resolveCheckoutSubaccount right after the provider call succeeds.
create function app.save_checkout_subaccount(
  target_business_id uuid,
  target_virtual_account_id uuid,
  subaccount_code text,
  bank_code text,
  account_number text,
  account_name text
)
returns void
language plpgsql volatile security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from app.virtual_accounts v
    where v."id" = target_virtual_account_id and v."businessId" = target_business_id
      and v."status" = 'active' and v."accountNumber" = account_number
  ) then
    raise exception 'Settlement account does not match the business''s active virtual account';
  end if;

  update app.checkout_subaccounts set "status" = 'retired'
  where "businessId" = target_business_id and "provider" = 'paystack' and "status" = 'active';

  insert into app.checkout_subaccounts (
    "businessId", "provider", "subaccountCode", "virtualAccountId",
    "settlementBankCode", "settlementAccountNumber", "settlementAccountName"
  ) values (
    target_business_id, 'paystack', subaccount_code, target_virtual_account_id,
    bank_code, account_number, account_name
  );
end;
$$;

revoke all on function app.save_checkout_subaccount(uuid, uuid, text, text, text, text) from public;
grant execute on function app.save_checkout_subaccount(uuid, uuid, text, text, text, text) to scripe_app;

-- ---------------------------------------------------------------------------
-- Part 2: invoice notifications
-- ---------------------------------------------------------------------------

alter table app.invoices add column "transferReportedAt" timestamptz;

create or replace function app.get_public_invoice(target_token text)
returns jsonb
language plpgsql stable security definer
set search_path = app, pg_temp
as $$
declare
  inv record;
  ord record;
  biz record;
  cust record;
  lines_json jsonb;
  paid_minor bigint := 0;
  total_minor bigint := 0;
  calculated_status text;
begin
  select i.* into inv
  from app.invoices i
  where i."publicToken" = target_token and i."status" <> 'draft'
  limit 1;

  if inv is null then
    return null;
  end if;

  select
    b."displayName",
    b."website",
    coalesce(nullif(b."addressLine1", ''), loc."addressLine1") as "addressLine1",
    coalesce(nullif(b."addressLine2", ''), loc."addressLine2") as "addressLine2",
    coalesce(nullif(b."city", ''), loc."city") as "city",
    coalesce(nullif(b."state", ''), loc."state") as "state",
    coalesce(nullif(b."postalCode", ''), loc."postalCode") as "postalCode",
    coalesce(nullif(b."country", ''), loc."countryCode", 'Nigeria') as "country",
    loc."phone" as "phone"
  into biz
  from app.businesses b
  left join lateral (
    select l.* from app.locations l
    where l."businessId" = b."id" and (l."storeId" = inv."storeId" or l."isDefault")
    order by l."isDefault" desc limit 1
  ) loc on true
  where b."id" = inv."businessId";

  if inv."customerPartyId" is not null then
    select p."displayName" as "name",
      (select pc."value" from app.party_contacts pc
       where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'email' and pc."status" = 'active'
       order by pc."isPrimary" desc, pc."createdAt" limit 1) as "email",
      (select pc."value" from app.party_contacts pc
       where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'phone' and pc."status" = 'active'
       order by pc."isPrimary" desc, pc."createdAt" limit 1) as "phone",
      (select pa."line1" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "addressLine1",
      (select pa."line2" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "addressLine2",
      (select pa."city" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "city",
      (select pa."state" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "state",
      (select pa."postalCode" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "postalCode",
      (select pa."countryCode" from app.party_addresses pa
       where pa."partyId" = p."id" and pa."businessId" = p."businessId" and pa."status" = 'active'
       order by pa."isDefault" desc, pa."createdAt" desc limit 1) as "country"
    into cust
    from app.parties p
    where p."id" = inv."customerPartyId" and p."businessId" = inv."businessId";
  end if;

  if inv."orderId" is not null then
    select o."paymentStatus", o."totalMinor" into ord
    from app.orders o
    where o."id" = inv."orderId" and o."businessId" = inv."businessId";

    select coalesce(sum(p."amountMinor"), 0) into paid_minor
    from app.payments p
    where p."orderId" = inv."orderId" and p."businessId" = inv."businessId" and p."status" in ('captured', 'authorized');
  end if;

  total_minor := inv."totalMinor";

  if inv."status" = 'void' then
    calculated_status := 'void';
  elsif ord."paymentStatus" = 'paid' or (total_minor > 0 and paid_minor >= total_minor) then
    calculated_status := 'paid';
  elsif paid_minor > 0 then
    calculated_status := 'partially_paid';
  elsif inv."dueDate" < app.invoice_local_today(inv."storeId") then
    calculated_status := 'overdue';
  else
    calculated_status := 'pending';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', l."id",
      'description', l."description",
      'quantity', l."quantity",
      'unitPriceMinor', l."unitPriceMinor",
      'taxRateBps', l."taxRateBps",
      'discountMinor', l."discountMinor",
      'lineTotalMinor', l."lineTotalMinor",
      'productVariantId', l."productVariantId"
    ) order by l."sortOrder", l."createdAt"
  ), '[]'::jsonb)
  into lines_json
  from app.invoice_lines l
  where l."invoiceId" = inv."id";

  return jsonb_build_object(
    'id', inv."id",
    'invoiceNumber', inv."invoiceNumber",
    'status', calculated_status,
    'documentStatus', inv."status",
    'issueDate', inv."issueDate",
    'dueDate', inv."dueDate",
    'currency', inv."currency",
    'subtotalMinor', inv."subtotalMinor",
    'taxMinor', inv."taxMinor",
    'discountMinor', inv."discountMinor",
    'totalMinor', total_minor,
    'amountPaidMinor', paid_minor,
    'balanceDueMinor', greatest(0, total_minor - paid_minor),
    'notes', inv."notes",
    'terms', inv."terms",
    'sentAt', inv."sentAt",
    'transferReportedAt', inv."transferReportedAt",
    'business', jsonb_build_object(
      'displayName', biz."displayName",
      'website', biz."website",
      'phone', biz."phone",
      'addressLine1', biz."addressLine1",
      'addressLine2', biz."addressLine2",
      'city', biz."city",
      'state', biz."state",
      'postalCode', biz."postalCode",
      'country', biz."country"
    ),
    'customer', jsonb_build_object(
      'name', cust."name",
      'email', cust."email",
      'phone', cust."phone",
      'addressLine1', cust."addressLine1",
      'addressLine2', cust."addressLine2",
      'city', cust."city",
      'state', cust."state",
      'postalCode', cust."postalCode",
      'country', cust."country"
    ),
    'bankDetails', case when inv."payToAccountNumber" is not null then jsonb_build_object(
      'bankName', inv."payToBankName",
      'accountNumber', inv."payToAccountNumber",
      'accountName', inv."payToAccountName"
    ) else null end,
    'lines', lines_json
  );
end;
$$;

revoke all on function app.get_public_invoice(text) from public;
grant execute on function app.get_public_invoice(text) to scripe_app;


create function app.get_invoice_payment_notification(target_order_id uuid)
returns table (
  "invoiceId" uuid,
  "businessId" uuid,
  "invoiceNumber" text,
  "publicToken" text,
  "currency" text,
  "totalMinor" bigint,
  "amountPaidMinor" bigint,
  "balanceDueMinor" bigint,
  "businessName" text,
  "ownerUserId" uuid,
  "merchantEmail" text,
  "customerName" text,
  "customerEmail" text
)
language sql stable security definer
set search_path = ''
as $$
  select
    i."id", i."businessId", i."invoiceNumber", i."publicToken", i."currency", i."totalMinor",
    paid."amount", greatest(0::bigint, i."totalMinor" - paid."amount"),
    b."displayName", b."createdBy", u."email",
    party."displayName",
    (select pc."value" from app.party_contacts pc
      where pc."partyId" = party."id" and pc."businessId" = party."businessId" and pc."kind" = 'email' and pc."status" = 'active'
      order by pc."isPrimary" desc, pc."createdAt" limit 1)
  from app.invoices i
  join app.businesses b on b."id" = i."businessId"
  left join auth.user u on u."id" = b."createdBy"
  left join app.parties party on party."id" = i."customerPartyId" and party."businessId" = i."businessId"
  cross join lateral (
    select coalesce(sum(p."amountMinor"), 0)::bigint as "amount" from app.payments p
    where p."orderId" = i."orderId" and p."businessId" = i."businessId" and p."status" in ('captured', 'authorized')
  ) paid
  where i."orderId" = target_order_id and i."status" = 'open'
  limit 1;
$$;

revoke all on function app.get_invoice_payment_notification(uuid) from public;
grant execute on function app.get_invoice_payment_notification(uuid) to scripe_app;

-- Records the customer's "I have paid by transfer" on an open, unpaid
-- invoice. "firstReport" is false when it was already reported in the last
-- 24 hours, so a repeated click doesn't notify the merchant again.
create function app.report_public_invoice_transfer(target_token text)
returns table (
  "invoiceId" uuid,
  "businessId" uuid,
  "invoiceNumber" text,
  "currency" text,
  "balanceDueMinor" bigint,
  "businessName" text,
  "ownerUserId" uuid,
  "merchantEmail" text,
  "customerName" text,
  "firstReport" boolean
)
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  inv record;
  paid_minor bigint := 0;
  balance_due bigint := 0;
  is_first boolean;
begin
  select i.* into inv
  from app.invoices i
  where i."publicToken" = target_token and i."status" = 'open'
  limit 1
  for update;

  if inv is null or inv."orderId" is null then
    return;
  end if;

  select coalesce(sum(p."amountMinor"), 0) into paid_minor
  from app.payments p
  where p."orderId" = inv."orderId" and p."businessId" = inv."businessId" and p."status" in ('captured', 'authorized');
  balance_due := greatest(0::bigint, inv."totalMinor" - paid_minor);

  if balance_due <= 0 then
    return;
  end if;

  is_first := inv."transferReportedAt" is null or inv."transferReportedAt" < now() - interval '24 hours';
  if is_first then
    update app.invoices set "transferReportedAt" = now() where "id" = inv."id";
  end if;

  return query
  select inv."id", inv."businessId", inv."invoiceNumber", inv."currency", balance_due,
    b."displayName", b."createdBy", u."email", party."displayName", is_first
  from app.businesses b
  left join auth.user u on u."id" = b."createdBy"
  left join app.parties party on party."id" = inv."customerPartyId" and party."businessId" = inv."businessId"
  where b."id" = inv."businessId";
end;
$$;

revoke all on function app.report_public_invoice_transfer(text) from public;
grant execute on function app.report_public_invoice_transfer(text) to scripe_app;
