-- 0083_app_checkout_settlement.down.sql
drop function if exists app.report_public_invoice_transfer(text);
drop function if exists app.get_invoice_payment_notification(uuid);

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


alter table app.invoices drop column if exists "transferReportedAt";

drop function if exists app.save_checkout_subaccount(uuid, uuid, text, text, text, text);
drop function if exists app.get_checkout_settlement_target(uuid);
drop table if exists app.checkout_subaccounts;
