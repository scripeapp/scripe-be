-- product_branch_overrides is now catalog-only. Rename it to make the domain
-- boundary with branch_inventory_overrides explicit.
ALTER TABLE public.product_branch_overrides
  RENAME TO branch_catalog_overrides;

ALTER TABLE public.branch_catalog_overrides
  RENAME CONSTRAINT unique_product_branch_override
  TO unique_branch_catalog_override;

ALTER INDEX public.idx_product_branch_overrides_product
  RENAME TO idx_branch_catalog_overrides_product;

ALTER INDEX public.idx_product_branch_overrides_branch
  RENAME TO idx_branch_catalog_overrides_branch;

ALTER POLICY "Business members manage product branch overrides"
  ON public.branch_catalog_overrides
  RENAME TO "Business members manage branch catalog overrides";

ALTER POLICY "Public view product branch overrides"
  ON public.branch_catalog_overrides
  RENAME TO "Public view branch catalog overrides";

COMMENT ON TABLE public.branch_catalog_overrides IS
  'Sparse branch-specific product catalog overrides for availability, price, currency prices, and lead time. Inventory lives in branch_inventory_overrides.';
