-- record_supplier_payment (20260906_supplier_procurement_phase_one.sql) only
-- rolls up the linked bill's paid_amount/status at INSERT time, when the
-- caller already knows the final status. A real Paystack-backed transfer
-- doesn't work that way: it's inserted as 'pending'/'processing' before the
-- outcome is known, and only settles later — via the initiate response
-- itself, a requery, or the transfer webhook. This adds the missing
-- "finalize an existing payment" half: updates the payment row and, only on
-- a transition into 'successful', performs the exact same bill rollup
-- record_supplier_payment already does on insert. SECURITY DEFINER from the
-- start (see 20260907_procurement_rpc_security_definer.sql for why this
-- codebase's multi-table RPCs need it, not SECURITY INVOKER).

CREATE OR REPLACE FUNCTION finalize_supplier_payment(
  p_payment_id UUID,
  p_status TEXT,
  p_provider_transfer_code TEXT DEFAULT NULL,
  p_failure_reason TEXT DEFAULT NULL
)
RETURNS supplier_payments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_payment supplier_payments%ROWTYPE;
  v_bill supplier_bills%ROWTYPE;
  v_paid_amount NUMERIC;
BEGIN
  IF p_status NOT IN ('pending', 'processing', 'successful', 'failed', 'reversed') THEN
    RAISE EXCEPTION 'Invalid supplier payment status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_payment FROM supplier_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Supplier payment not found' USING ERRCODE = 'P0002';
  END IF;

  -- Idempotent: a webhook can fire more than once, and finalize can race a
  -- requery — once this payment has already reached a terminal state,
  -- silently return it unchanged rather than double-applying the rollup.
  IF v_payment.status IN ('successful', 'failed', 'reversed') THEN
    RETURN v_payment;
  END IF;

  UPDATE supplier_payments
  SET status = p_status,
      provider_transfer_code = COALESCE(p_provider_transfer_code, provider_transfer_code),
      failure_reason = CASE WHEN p_status = 'failed' THEN p_failure_reason ELSE failure_reason END,
      updated_at = now()
  WHERE id = p_payment_id
  RETURNING * INTO v_payment;

  IF p_status = 'successful' AND v_payment.bill_id IS NOT NULL THEN
    SELECT * INTO v_bill FROM supplier_bills WHERE id = v_payment.bill_id FOR UPDATE;
    IF FOUND AND v_bill.status <> 'cancelled' THEN
      v_paid_amount := v_bill.paid_amount + v_payment.amount;
      UPDATE supplier_bills
      SET paid_amount = v_paid_amount,
          status = CASE WHEN v_paid_amount >= amount THEN 'paid' ELSE 'partially_paid' END,
          updated_at = now()
      WHERE id = v_payment.bill_id;
    END IF;
  END IF;

  RETURN v_payment;
END;
$$;
