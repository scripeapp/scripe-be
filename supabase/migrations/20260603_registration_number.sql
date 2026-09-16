-- ─────────────────────────────────────────────────────────────────────────────
-- Registration Number for issued_tickets
-- Gives each ticket a sequential per-event registration number (1, 2, 3 …)
-- assigned atomically using a Postgres advisory lock so no two tickets for
-- the same event can ever receive the same number.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the column (nullable so existing rows aren't affected immediately)
ALTER TABLE issued_tickets
ADD COLUMN IF NOT EXISTS registration_number INTEGER;

-- 2. Atomic assignment function
--    Called after each ticket INSERT. The advisory lock serialises concurrent
--    purchases for the same event — other events are never blocked.
CREATE OR REPLACE FUNCTION assign_registration_number(
  p_ticket_id UUID,
  p_event_id  UUID
) RETURNS INTEGER AS $$
DECLARE
  next_num INTEGER;
BEGIN
  -- Acquire a transaction-scoped advisory lock keyed to this event.
  -- Any concurrent session calling this function for the same event_id will
  -- wait here until the current transaction commits and releases the lock.
  --
  -- Two-parameter form: (namespace int4, key int4) → combined 64-bit lock key.
  -- Namespace 7734 scopes these locks to registration-number assignment only,
  -- eliminating collisions with any other advisory locks in the system and
  -- reducing hash-collision probability between events to near-zero.
  PERFORM pg_advisory_xact_lock(7734, hashtext(p_event_id::text));

  -- Compute the next sequential number across all tickets for this event.
  SELECT COALESCE(MAX(registration_number), 0) + 1
  INTO next_num
  FROM issued_tickets
  WHERE event_id = p_event_id;

  -- Stamp the number onto the newly-inserted ticket.
  UPDATE issued_tickets
  SET registration_number = next_num
  WHERE id = p_ticket_id;

  RETURN next_num;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. Backfill existing tickets with sequential numbers ordered by purchase time
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY event_id
      ORDER BY created_at ASC NULLS LAST
    ) AS rn
  FROM issued_tickets
  WHERE registration_number IS NULL
)
UPDATE issued_tickets it
SET    registration_number = r.rn
FROM   ranked r
WHERE  it.id = r.id;

-- 4. Now that all rows are populated, add a unique constraint
ALTER TABLE issued_tickets
ADD CONSTRAINT uq_issued_tickets_event_reg
UNIQUE (event_id, registration_number);
