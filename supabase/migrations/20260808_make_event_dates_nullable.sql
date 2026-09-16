-- Allow events to be published before a date is set. A NULL start_date means
-- the event date is "to be disclosed" (TBD) — the schedule is filled in later.
-- The remaining schedule columns are made nullable too so no orphaned time or
-- end date renders next to a TBD start date. Only start_date carries meaning
-- for TBD; a NULL end_date already means "same day as start" elsewhere.
ALTER TABLE events
  ALTER COLUMN start_date DROP NOT NULL,
  ALTER COLUMN start_time DROP NOT NULL,
  ALTER COLUMN end_date DROP NOT NULL,
  ALTER COLUMN end_time DROP NOT NULL;
