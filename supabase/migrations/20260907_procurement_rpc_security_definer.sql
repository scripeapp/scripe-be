-- The phase-one procurement RPCs (create_completed_stock_receipt,
-- record_supplier_payment) were declared SECURITY INVOKER, unlike the
-- codebase's established convention for atomic multi-table stock/ledger
-- RPCs (see decrement_product_stock, SECURITY DEFINER since
-- 20260829_branch_variant_stock.sql / reaffirmed in
-- 20260902_stock_movement_reasons.sql).
--
-- Under SECURITY INVOKER, calling these via PostgREST's .rpc() as an
-- authenticated store member fails with:
--   "query would be affected by row-level security policy for table products"
-- on the plain `UPDATE products SET cost = ..., stock = ...` branch inside
-- create_completed_stock_receipt (hit whenever a receipt has no branch_id,
-- i.e. default/store-level inventory). record_supplier_payment performs the
-- same class of cross-table INSERT+UPDATE (supplier_payments, supplier_bills)
-- and would hit an equivalent failure once bill payments are exercised.
--
-- Both already do their own explicit authorization/ownership checks
-- (store_id/supplier_id scoping, FOR UPDATE row locks) inside the function
-- body, so running as SECURITY DEFINER is safe and matches
-- decrement_product_stock's precedent.
--
-- create_completed_stock_receipt's fix is folded into
-- 20260907_purchase_order_receiving_linkage.sql instead (its signature
-- changes there, so it's a DROP + full CREATE, not an ALTER) — only
-- record_supplier_payment is fixed here.

ALTER FUNCTION record_supplier_payment(
  UUID, UUID, UUID, NUMERIC, DATE, TEXT, TEXT, TEXT, UUID, TEXT
) SECURITY DEFINER SET search_path = public;
