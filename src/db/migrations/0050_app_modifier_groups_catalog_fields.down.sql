alter table app.modifier_options
  drop column "branchIds",
  drop column "isDefault",
  drop column "isAvailable";

drop index app.modifier_groups_store_order_idx;

alter table app.modifier_groups
  drop column "branchIds",
  drop column "sortOrder",
  drop column "kind",
  drop column "description",
  drop column "storeId";
