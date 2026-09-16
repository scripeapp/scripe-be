-- Change scheduled_bookings.event_type_id FK from CASCADE to SET NULL
-- so that deleting an event type keeps historical bookings intact.
-- The public booking link simply becomes inaccessible (event type no longer exists).

-- 1. Drop the existing NOT NULL constraint and FK
ALTER TABLE scheduled_bookings
  ALTER COLUMN event_type_id DROP NOT NULL;

-- 2. Drop the old FK constraint
ALTER TABLE scheduled_bookings
  DROP CONSTRAINT IF EXISTS scheduled_bookings_event_type_id_fkey;

-- 3. Re-add FK with ON DELETE SET NULL
ALTER TABLE scheduled_bookings
  ADD CONSTRAINT scheduled_bookings_event_type_id_fkey
  FOREIGN KEY (event_type_id)
  REFERENCES event_types(id)
  ON DELETE SET NULL;
