-- A till sale records the register shift it was rung up on, so closing the
-- shift can count its cash takings. Before this, expected cash was the
-- opening float plus manual cash movements only, and every cash sale showed
-- up as a variance.
alter table app.orders add column "registerShiftId" uuid references app.register_shifts ("id") on delete restrict;

create index orders_register_shift_idx on app.orders ("businessId", "registerShiftId")
  where "registerShiftId" is not null;
