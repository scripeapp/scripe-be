drop table if exists app.order_lines, app.orders, app.checkout_sessions, app.cart_lines, app.carts cascade;
delete from app.role_permissions where "permissionId" in (select "id" from app.permissions where "code" in ('cart.read','cart.manage','order.read','order.create'));
delete from app.permissions where "code" in ('cart.read','cart.manage','order.read','order.create');
