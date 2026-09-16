# Branch inventory overrides

Branch inventory is stored in `branch_inventory_overrides` at one mixed
grain:

- `variant_id IS NULL`: whole-product balance at a branch.
- `variant_id IS NOT NULL`: balance for one product variant at a branch.

The table is sparse. A missing row inherits the next inventory scope, while a
present row whose `stock_quantity` is `NULL` is explicitly unlimited. Zero is
an out-of-stock balance.

For a variant purchase, effective stock is resolved in this order:

1. Branch + product + variant row.
2. Branch + product row (`variant_id IS NULL`).
3. Global `product_variants.stock` and `products.stock` caps.

`branch_catalog_overrides` is the catalog-override table for branch
availability, price, currency prices, and lead time. Keeping it separate is
intentional: a catalog row may exist without overriding inventory, so it
cannot safely use row presence to distinguish inherited stock from explicit
unlimited stock.

The `decrement_product_stock` RPC resolves the effective row, locks it with
`FOR UPDATE`, checks available stock (excluding reservations), decrements the
balance, and appends the corresponding `stock_movements` entry in the same
database transaction. Variant rows are independently lockable, avoiding the
whole-product row contention caused by a JSONB variant map.

The branch-overrides HTTP endpoint continues to expose `variant_stock` as a
convenience map for the product editor. That map is only an API projection;
it is expanded into normalized rows before persistence and reconstructed on
read. In the product editor, a blank branch-stock field means inherit and the
word `unlimited` creates an explicit `NULL` balance.

## Catalog variant overrides (deferred)

For now, `branch_catalog_overrides` remains product-level: one row per
`(branch_id, product_id)`. Its availability, price, currency prices, and lead
time apply to the product and therefore its variants.

We may later reshape it to the same mixed grain used by inventory, with a
nullable `variant_id`:

- `variant_id IS NULL`: product-level catalog override.
- `variant_id IS NOT NULL`: variant-level catalog override.

That future design would use a composite product/variant foreign key and a
`UNIQUE NULLS NOT DISTINCT (branch_id, product_id, variant_id)` constraint.
It is intentionally deferred until branch-specific variant pricing or
availability is a confirmed product requirement, since it adds inheritance,
UI, and query complexity while the current product-level behavior is
sufficient.
