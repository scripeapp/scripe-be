drop function if exists app.update_delivery_from_webhook(text, text, jsonb);
drop table if exists app.deliveries;
drop table if exists app.delivery_zones;
drop table if exists app.delivery_methods;
alter table app.stores drop column if exists "carrierDeliveryEnabled";

alter table app.provider_events drop constraint provider_events_provider_check;
alter table app.provider_events add constraint provider_events_provider_check check ("provider" in ('paystack', 'flutterwave', 'anchor', 'brails'));

delete from app.role_permissions where "permissionId" in (
  select "id" from app.permissions where "code" in ('delivery.read', 'delivery.manage')
);
delete from app.permissions where "code" in ('delivery.read', 'delivery.manage');
