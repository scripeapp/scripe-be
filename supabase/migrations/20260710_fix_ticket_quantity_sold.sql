-- Migration: 2026-07-10
-- Fix corrupted event_tickets.quantity_sold values and introduce an atomic
-- DB-side increment RPC to prevent the same issue recurring.
--
-- Root cause: the application code read quantity_sold from a payment-metadata
-- snapshot and wrote `snapshot_value + new_quantity` back to the DB. When the
-- snapshot value was serialised as a string (by Flutterwave's metadata
-- flattening), JavaScript evaluated `"1" + 1 = "11"` instead of `2`, and
-- Postgres stored the string as an integer. Each sequential purchase compounded
-- the error.
--
-- Fix part 1: recompute quantity_sold from ticket_sales (the authoritative
-- ledger written during every purchase) for every corrupted row.

UPDATE event_tickets
SET quantity_sold = (
  SELECT COALESCE(SUM(ts.quantity_sold), 0)
  FROM ticket_sales ts
  WHERE ts.ticket_id = event_tickets.id
)
WHERE id IN (
  '61999163-daa5-4906-8d7b-4dd07ec16ed1', -- KBC 81: The Ummah Begins At Home     (was 111111111111, true: 161)
  'c437afa1-3859-445d-a818-0646e4f8605d', -- General Admission (Jun)               (was 111111111,    true: 151)
  '085f44a6-2941-4fbb-a025-15a095a2605f', -- Adults                                (was 315111,       true: 12)
  '637f1179-a63b-4929-b39a-e8d375c2c237', -- General admission (May)               (was 111111,       true: 336)
  '266ce8f7-2f73-4eba-a9ed-d722efb8e221', -- Ticket policy                         (was 12111,        true: 63)
  'a5cc175d-80a1-4137-a38d-d89291efd8e3', -- MTS 2.0 Early Bird Ticket Sales       (was 11111,        true: 5)
  '611dae3f-a840-4abc-b29d-a0e7967e4a0d', -- Osun Eid Fair 7.0 (Solo)             (was 1211,         true: 5)
  '6140c3ec-9cae-4c3d-acdf-eb7262577bb4'  -- Test                                  (was 1111,         true: 4)
);

-- Fix part 2: atomic RPC so the application never reads quantity_sold into
-- memory before writing it back. The DB does the arithmetic; type coercion
-- from the JS layer can no longer corrupt the value.

CREATE OR REPLACE FUNCTION increment_ticket_sold_quantity(
  p_ticket_id UUID,
  p_quantity  INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE event_tickets
  SET
    quantity_sold     = quantity_sold + p_quantity,
    available_quantity = CASE
      WHEN ticket_is_limited_stock THEN available_quantity - p_quantity
      ELSE available_quantity
    END
  WHERE id = p_ticket_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'event_ticket % not found', p_ticket_id;
  END IF;
END;
$$;
