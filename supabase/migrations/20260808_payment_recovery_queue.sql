-- Stores Paystack references that were paid but never fulfilled (no order row).
-- Populated by the reconcile-orphaned-payments cron job every 2 hours.
-- Admins resolve entries via the Payment Recovery page.
CREATE TABLE IF NOT EXISTS payment_recovery_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_reference   TEXT NOT NULL UNIQUE,
  paystack_amount     INTEGER NOT NULL,         -- in kobo
  paystack_email      TEXT,
  paystack_paid_at    TIMESTAMPTZ,
  paystack_metadata   JSONB,
  resolved_at         TIMESTAMPTZ,
  resolved_by         UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS payment_recovery_queue_resolved_at_idx
  ON payment_recovery_queue (resolved_at)
  WHERE resolved_at IS NULL;
