-- 0081_app_paylinks_hardening.down.sql

drop function if exists app.consume_rate_limit(text, integer, integer);
drop table if exists app.rate_limit_counters;

drop function if exists app.get_paylink_payment_notification(text);
drop function if exists app.get_checkout_payment_by_reference(text);
drop function if exists app.set_paylink_checkout_url(text, text);
drop function if exists app.record_public_paylink_checkout(text, text, text, text, text, bigint, text, text, uuid, integer, text, text, text, jsonb);

-- 0080's checkout function is not restored here: it referenced a table that
-- does not exist. Re-run 0080 down/up to get back to that exact state.

alter table app.payment_attempts drop column if exists "checkoutUrl";
alter table app.orders drop column if exists "deliveryAddress";

alter table app.paylinks drop constraint if exists paylinks_redirect_https_check;
alter table app.paylinks drop constraint if exists paylinks_fixed_amount_check;

create index if not exists paylinks_slug_idx on app.paylinks ("slug");

alter table app.orders drop constraint if exists "orders_paylinkId_businessId_fkey";
alter table app.orders add constraint "orders_paylinkId_fkey"
  foreign key ("paylinkId") references app.paylinks ("id") on delete set null;

alter table app.paylinks drop constraint if exists "paylinks_productVariantId_businessId_fkey";
alter table app.paylinks add constraint "paylinks_productVariantId_businessId_fkey"
  foreign key ("productVariantId", "businessId") references app.product_variants ("id", "businessId") on delete set null;

create policy paylinks_public_read on app.paylinks for select using ("status" = 'active');
