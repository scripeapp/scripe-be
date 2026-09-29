-- Storefront and till shoppers see a product's modifier and add-on groups
-- (sizes, extras, "beard trim +15 min"). Same model as 0046: active groups
-- and options on active products are public data by design.
create policy modifier_groups_public_read on app.modifier_groups for select
  using ("status" = 'active');

create policy modifier_options_public_read on app.modifier_options for select
  using (
    "status" = 'active'
    and exists (
      select 1 from app.modifier_groups modifier_group
      where modifier_group."id" = "groupId" and modifier_group."status" = 'active'
    )
  );

create policy product_modifier_groups_public_read on app.product_modifier_groups for select
  using (
    exists (
      select 1 from app.products product
      where product."id" = "productId" and product."status" = 'active'
    )
  );
