-- Paying a supplier bill from the wallet is a distinct ledger category from
-- 'withdrawal' (money leaving to the business's OWN settlement account) —
-- mislabeling it would confuse future bookkeeping/reporting. Purely
-- additive: existing rows and the 'withdrawal' path are untouched.
ALTER TABLE wallet_transactions
  DROP CONSTRAINT IF EXISTS wallet_transactions_type_check;
ALTER TABLE wallet_transactions
  ADD CONSTRAINT wallet_transactions_type_check
  CHECK (type IN ('deposit', 'withdrawal', 'reversal', 'adjustment', 'bill_payment'));
