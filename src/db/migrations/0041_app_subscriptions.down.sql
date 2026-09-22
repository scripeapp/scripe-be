drop function if exists app.find_business_owner_email(uuid);
drop function if exists app.list_past_due_subscriptions_for_dunning();
drop function if exists app.record_subscription_payment_failure(uuid, bigint, text);
drop function if exists app.set_business_subscription_status(uuid, text, timestamptz);
drop function if exists app.record_recurring_subscription_payment(text, bigint, timestamptz, text);
drop function if exists app.activate_business_subscription(uuid, text, text, text, text, timestamptz, bigint, text);
drop function if exists app.get_business_entitlement(uuid, text);
drop table if exists app.subscription_dunning_events;
drop table if exists app.subscription_payment_attempts;
drop table if exists app.subscription_invoices;
drop table if exists app.business_subscriptions;
drop table if exists app.platform_plan_entitlements;
drop table if exists app.platform_plans;

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('subscription.read', 'subscription.manage')
);
delete from app.permissions where "code" in ('subscription.read', 'subscription.manage');
