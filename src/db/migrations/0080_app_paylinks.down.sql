-- 0080_app_paylinks.down.sql

drop function if exists app.get_public_paylink_checkout_status(text);
drop function if exists app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text);
drop function if exists app.get_public_paylink(text);

drop policy if exists paylinks_public_read on app.paylinks;
drop policy if exists paylinks_manage on app.paylinks;
drop policy if exists paylinks_read on app.paylinks;

alter table app.orders drop column if exists "paylinkId";

drop table if exists app.paylinks;

delete from app.role_permissions
where "permissionId" in (
  select "id" from app.permissions where "code" in ('paylink.read', 'paylink.manage')
);

delete from app.permissions where "code" in ('paylink.read', 'paylink.manage');
