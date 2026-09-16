# Supplier Procurement Implementation

This note records the implementation state of `supplier-data-model.md`.

## Delivered

- `supplier_products` is the source of truth for many-to-many supplier/product sourcing.
- `stock_receipts` and `stock_receipt_lines` are atomic receiving documents. Accepted tracked lines create attributed ledger movements; rejected quantities remain auditable without affecting stock.
- Supplier bills expose `paid_amount` and `partially_paid`; payment reconciliation runs through `record_supplier_payment`.
- Products can be marked `is_sellable = false`; storefront, catalog facets, product quotas, and public product lists exclude those rows.
- `purchase_orders` and `purchase_order_lines` provide tenant-scoped procurement intent with ordered/received quantities, supplier, branch, expected delivery, and lifecycle status.
- Receipt lines and supplier bill items can link to purchase-order lines. Receipt headers can link to a purchase order for the common receiving flow.
- Transfer lines carry batch/expiry metadata and receiving movements copy unit cost and traceability fields.
- `stock_batch_balances` provides on-hand batch balances for expiry reporting and future FEFO decrement work.

## HTTP routes

`GET/POST /store/purchase-orders`, `GET/PATCH /store/purchase-orders/:purchaseOrderId`, and the existing supplier receipt/bill/payment routes are protected by store permissions and request validation. All service reads and writes include `store_id` scope checks.

## Verification

Backend `npm run type-check`, focused supplier/catalog/store tests, and frontend TypeScript checks pass. Supabase local lint requires a running local Postgres instance; the repository environment did not have one available, so migration execution should be run in CI or against a disposable Supabase project before production rollout.

## Follow-up boundary

The batch balance view is shipped as a read model. FEFO selection must be implemented inside the sale decrement transaction so concurrent sales cannot select the same batch; it is intentionally not simulated in the browser.
