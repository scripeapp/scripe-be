-- Public (anonymous) read access for the storefront browsing surface:
-- a store, its products/variants, and its categories become visible to
-- anyone once the merchant sets them to "active" — that is what "active"
-- means for a storefront. Unlike the avatar case (migration 0045), this is
-- genuinely public data by design, so a plain permissive RLS policy is the
-- right tool here rather than a narrowly-scoped SECURITY DEFINER function:
-- Postgres OR's permissive policies together, so the existing staff
-- has_business_permission policies are unaffected and still apply for
-- non-active rows and for staff managing their own business's data.
--
-- Scope: browsing only (store, products, variants, prices, categories).
-- Cart/checkout/payment/order-lookup are a separate, not-yet-built pass —
-- see the public-storefront gap this migration is the first slice of.

create policy stores_public_read on app.stores for select
  using ("status" = 'active');

create policy products_public_read on app.products for select
  using ("status" = 'active');

create policy product_variants_public_read on app.product_variants for select
  using (
    "status" = 'active'
    and exists (
      select 1 from app.products product
      where product."id" = "productId" and product."status" = 'active'
    )
  );

create policy product_prices_public_read on app.product_prices for select
  using (
    "status" = 'active'
    and exists (
      select 1 from app.product_variants variant
      join app.products product on product."id" = variant."productId"
      where variant."id" = "productVariantId"
        and variant."status" = 'active'
        and product."status" = 'active'
    )
  );

create policy categories_public_read on app.categories for select
  using ("status" = 'active');
