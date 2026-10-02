-- 0084_app_paylinks_operations.down.sql

drop function if exists app.count_recent_webhook_signature_failures(interval);
drop function if exists app.list_stale_paylink_payments(interval, timestamptz, integer);
drop function if exists app.business_accepting_payments(uuid);

delete from app.platform_plan_entitlements where "key" = 'active_paylinks';

-- Restore 0081's notification function (fewer result columns).
drop function if exists app.get_paylink_payment_notification(text);

create function app.get_paylink_payment_notification(target_ref text)
returns table (
  "orderNumber" text,
  "amountMinor" bigint,
  "currency" text,
  "paylinkTitle" text,
  "businessName" text,
  "merchantEmail" text,
  "customerName" text,
  "customerEmail" text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    o."orderNumber",
    pm."amountMinor",
    pm."assetCode",
    pl."title",
    b."displayName",
    u."email",
    party."displayName",
    (select pc."value" from app.party_contacts pc
      where pc."partyId" = party."id" and pc."businessId" = party."businessId" and pc."kind" = 'email'
      order by pc."isPrimary" desc limit 1)
  from app.payments pm
  join app.orders o on o."id" = pm."orderId" and o."businessId" = pm."businessId"
  join app.paylinks pl on pl."id" = o."paylinkId" and pl."businessId" = o."businessId"
  join app.businesses b on b."id" = o."businessId"
  left join auth.user u on u."id" = b."createdBy"
  left join app.parties party on party."id" = o."customerPartyId" and party."businessId" = o."businessId"
  where pm."externalReference" = target_ref and pm."status" = 'captured'
  limit 1;
$$;

revoke all on function app.get_paylink_payment_notification(text) from public;
grant execute on function app.get_paylink_payment_notification(text) to scripe_app;
