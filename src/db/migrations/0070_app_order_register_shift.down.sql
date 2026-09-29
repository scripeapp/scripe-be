drop index if exists app.orders_register_shift_idx;
alter table app.orders drop column "registerShiftId";
