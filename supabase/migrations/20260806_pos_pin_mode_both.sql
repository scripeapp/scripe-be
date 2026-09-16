-- Adds a real third staff-PIN policy, "both": a PIN unlocks the till for
-- the shift (like per_session), but the cashier must still confirm their
-- PIN before every individual charge (like per_sale) — belt-and-suspenders,
-- not a relabeling of the existing two options.
--
-- Also flips the default to per_session ("per shift"): entering a PIN once
-- per shift is the sane default for most stores; per_sale/both remain
-- opt-in for stores that want stricter per-charge attribution. Existing
-- stores keep whatever value they currently have — there's no way to
-- distinguish "never touched, still on the old default" from "explicitly
-- chose per_sale," so this only changes the default going forward.
-- Finds and drops whatever the existing check constraint on this column is
-- actually named (rather than assuming Postgres's default auto-naming),
-- so this migration doesn't depend on guessing right.
DO $$
DECLARE
  existing_constraint text;
BEGIN
  SELECT con.conname INTO existing_constraint
  FROM pg_constraint con
  JOIN pg_attribute att
    ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
  WHERE con.conrelid = 'stores'::regclass
    AND con.contype = 'c'
    AND att.attname = 'pos_pin_mode';

  IF existing_constraint IS NOT NULL THEN
    EXECUTE format('ALTER TABLE stores DROP CONSTRAINT %I', existing_constraint);
  END IF;
END $$;

ALTER TABLE stores ALTER COLUMN pos_pin_mode SET DEFAULT 'per_session';
ALTER TABLE stores ADD CONSTRAINT stores_pos_pin_mode_check
  CHECK (pos_pin_mode IN ('per_sale', 'per_session', 'both'));

NOTIFY pgrst, 'reload schema';
