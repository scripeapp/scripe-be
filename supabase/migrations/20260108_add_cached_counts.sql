-- Add Cached Counts to Sessions Table for Performance
-- Eliminates N+1 queries in list endpoints with database triggers

BEGIN;

-- Add cached count columns
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS cached_members_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cached_upcoming_occurrences_count INTEGER DEFAULT 0;

-- Create function to update members count
CREATE OR REPLACE FUNCTION update_session_members_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE sessions 
    SET cached_members_count = cached_members_count + 1 
    WHERE id = NEW.session_id;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE sessions 
    SET cached_members_count = GREATEST(0, cached_members_count - 1)
    WHERE id = OLD.session_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for members count
DROP TRIGGER IF EXISTS session_members_count_trigger ON session_members;
CREATE TRIGGER session_members_count_trigger
AFTER INSERT OR DELETE ON session_members
FOR EACH ROW EXECUTE FUNCTION update_session_members_count();

-- Create function to update upcoming occurrences count
CREATE OR REPLACE FUNCTION update_session_occurrences_count()
RETURNS TRIGGER AS $$
DECLARE
  affected_session_id UUID;
BEGIN
  -- Determine which session to update
  IF TG_OP = 'DELETE' THEN
    affected_session_id := OLD.session_id;
  ELSE
    affected_session_id := NEW.session_id;
  END IF;

  -- Recalculate count for the affected session
  UPDATE sessions 
  SET cached_upcoming_occurrences_count = (
    SELECT COUNT(*) 
    FROM session_occurrences
    WHERE session_id = affected_session_id
    AND start_datetime > NOW()
    AND deleted_at IS NULL
  ) 
  WHERE id = affected_session_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for occurrences count
DROP TRIGGER IF EXISTS session_occurrences_count_trigger ON session_occurrences;
CREATE TRIGGER session_occurrences_count_trigger
AFTER INSERT OR DELETE OR UPDATE OF start_datetime ON session_occurrences
FOR EACH ROW EXECUTE FUNCTION update_session_occurrences_count();

-- Backfill existing data
UPDATE sessions SET cached_members_count = (
  SELECT COUNT(*) 
  FROM session_members 
  WHERE session_id = sessions.id
);

UPDATE sessions SET cached_upcoming_occurrences_count = (
  SELECT COUNT(*) 
  FROM session_occurrences 
  WHERE session_id = sessions.id 
  AND start_datetime > NOW()
);

-- Add indexes for the new columns (for sorting/filtering)
CREATE INDEX IF NOT EXISTS idx_sessions_cached_members_count ON sessions(cached_members_count);
CREATE INDEX IF NOT EXISTS idx_sessions_cached_upcoming_occurrences_count ON sessions(cached_upcoming_occurrences_count);

-- Comments for documentation
COMMENT ON COLUMN sessions.cached_members_count IS 'Cached count of session members, updated by trigger';
COMMENT ON COLUMN sessions.cached_upcoming_occurrences_count IS 'Cached count of upcoming occurrences, updated by trigger';

COMMIT;
