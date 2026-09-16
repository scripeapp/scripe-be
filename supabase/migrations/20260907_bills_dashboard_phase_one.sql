-- Bill pay dashboard, phase one: schema additions to wire the store-wide
-- "Payments > Bill pay" screen (currently mock data) onto the real
-- supplier_bills / supplier_bill_items / supplier_payments tables, and to
-- prepare supplier_payments for real Paystack-backed vendor disbursements
-- (reusing the existing wallet-withdrawal transfer rail) in a later phase.

-- supplier_bills: category (matches the frontend BillCategory union) and a
-- subtotal/tax breakdown so the API can return them without recomputing
-- from line items on every read. `amount` keeps its existing meaning as the
-- bill total (unchanged — other code already reads it that way).
ALTER TABLE supplier_bills
  ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Other',
  ADD COLUMN IF NOT EXISTS subtotal NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  ADD COLUMN IF NOT EXISTS tax_amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0);

ALTER TABLE supplier_bills
  DROP CONSTRAINT IF EXISTS supplier_bills_category_check;
ALTER TABLE supplier_bills
  ADD CONSTRAINT supplier_bills_category_check
  CHECK (category IN (
    'Inventory', 'Software', 'Logistics', 'Utilities', 'Marketing', 'Rent',
    'Consulting', 'Subscriptions', 'Operations', 'Professional fees', 'Other'
  ));

-- 'rejected' is a real terminal state once approvals are wired (phase two);
-- the column already exists, this just widens what it may hold.
ALTER TABLE supplier_bills
  DROP CONSTRAINT IF EXISTS supplier_bills_status_check;
ALTER TABLE supplier_bills
  ADD CONSTRAINT supplier_bills_status_check
  CHECK (status IN ('draft', 'pending', 'approved', 'partially_paid', 'paid', 'overdue', 'disputed', 'cancelled', 'rejected'));

-- supplier_bill_items: per-line tax rate, matching purchase_order_lines'
-- tax_rate column (percentage, e.g. 7.5 for 7.5%). `total` stays pre-tax
-- (quantity * unit_price, generated) — tax is computed at the bill level
-- from these rates, same as CreateBillFlow already does client-side.
ALTER TABLE supplier_bill_items
  ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(7,4) NOT NULL DEFAULT 0 CHECK (tax_rate >= 0);

-- suppliers: a real Paystack bank_code alongside the existing free-text
-- bank_name, needed to create a transfer recipient for vendor disbursements.
-- Nullable — existing vendors won't have one until re-saved through a
-- bank-select control (phase two, frontend).
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS bank_code TEXT;

-- supplier_payments: transfer-tracking columns so a single real (Paystack
-- wallet transfer) or manual (bookkeeping) payment record can live in one
-- table, reconciled the same way banking_withdrawals already is. All
-- nullable — a manual "record a payment" entry leaves these unset.
ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS transfer_recipient_code TEXT,
  ADD COLUMN IF NOT EXISTS provider_transfer_code TEXT,
  ADD COLUMN IF NOT EXISTS provider_reference TEXT,
  ADD COLUMN IF NOT EXISTS failure_reason TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS supplier_payments_provider_reference_idx
  ON supplier_payments (provider_reference)
  WHERE provider_reference IS NOT NULL;

-- 'processing' covers the window between initiating a transfer and the
-- webhook (or a requery) confirming it settled, same as banking_withdrawals.
ALTER TABLE supplier_payments
  DROP CONSTRAINT IF EXISTS supplier_payments_status_check;
ALTER TABLE supplier_payments
  ADD CONSTRAINT supplier_payments_status_check
  CHECK (status IN ('pending', 'processing', 'successful', 'failed', 'reversed'));
