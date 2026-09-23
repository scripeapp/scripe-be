drop table if exists app.stock_count_lines;
drop table if exists app.stock_counts;
drop table if exists app.stock_transfer_lines;
drop table if exists app.stock_transfers;
drop index if exists app.inventory_items_business_variant_idx;
alter table app.inventory_locations drop constraint inventory_locations_business_location_key;
alter table app.inventory_locations add constraint "inventory_locations_businessId_locationId_name_key" unique ("businessId", "locationId", "name");
