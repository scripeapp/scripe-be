-- Phase 2 (SERVICE_BOOKINGS_DESIGN.md § Commission & reporting, § Build order):
-- per-staff-member commission. The commission report endpoint computes a member's
-- service revenue from completed booking_items (staffId + priceMinor already live
-- on each item); commission is the simple percentage of service revenue the design
-- names. Tips and order-level staff attribution land with the Phase 2 POS till, so
-- the report's tips figure stays at zero until those orders exist.
-- RLS is already enabled on app.staff_profiles (0059) and the existing team.read /
-- team.manage policies cover this column; table-level grants apply to it untouched.
alter table app.staff_profiles
  add column "commissionPercent" smallint not null default 0
  check ("commissionPercent" between 0 and 100);