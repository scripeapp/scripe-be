-- 0078_app_invoices_sweep.sql

create or replace function app.list_overdue_invoices_for_sweep()
returns table (
  "id" uuid,
  "businessId" uuid,
  "invoiceNumber" text,
  "currency" text,
  "totalMinor" bigint,
  "balanceDueMinor" bigint,
  "dueDate" date,
  "businessName" text,
  "customerName" text,
  "customerEmail" text,
  "publicToken" text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  select
    i."id",
    i."businessId",
    i."invoiceNumber",
    i."currency",
    i."totalMinor",
    greatest(0::bigint, (i."totalMinor" - coalesce((
      select sum(p."amountMinor") from app.payments p
      where p."orderId" = i."orderId" and p."businessId" = i."businessId" and p."status" in ('captured', 'authorized')
    ), 0))::bigint),
    i."dueDate",
    b."displayName",
    coalesce(p."displayName", 'Customer'),
    (
      select pc."value" from app.party_contacts pc
      where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'email' and pc."status" = 'active'
      order by pc."isPrimary" desc, pc."createdAt" limit 1
    ),
    i."publicToken"
  from app.invoices i
  join app.businesses b on b."id" = i."businessId"
  left join app.parties p on p."id" = i."customerPartyId" and p."businessId" = i."businessId"
  left join app.orders o on o."id" = i."orderId" and o."businessId" = i."businessId"
  where i."status" = 'open'
    and i."dueDate" < current_date
    and (o."paymentStatus" is null or o."paymentStatus" <> 'paid')
    and (i."lastReminderAt" is null or i."lastReminderAt" < now() - interval '24 hours')
    and (
      i."totalMinor" > coalesce((
        select sum(p."amountMinor") from app.payments p
        where p."orderId" = i."orderId" and p."businessId" = i."businessId" and p."status" in ('captured', 'authorized')
      ), 0)
    )
    and exists (
      select 1 from app.party_contacts pc
      where pc."partyId" = p."id" and pc."businessId" = p."businessId" and pc."kind" = 'email' and pc."status" = 'active'
    );
end;
$$;

revoke all on function app.list_overdue_invoices_for_sweep() from public;
grant execute on function app.list_overdue_invoices_for_sweep() to scripe_app;

create or replace function app.record_invoice_sweep_reminder_sent(target_invoice_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update app.invoices
  set "lastReminderAt" = now()
  where "id" = target_invoice_id;
end;
$$;

revoke all on function app.record_invoice_sweep_reminder_sent(uuid) from public;
grant execute on function app.record_invoice_sweep_reminder_sent(uuid) to scripe_app;
