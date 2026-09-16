-- Add cached total sessions count to circles table

ALTER TABLE circles ADD COLUMN IF NOT EXISTS cached_sessions_count INTEGER DEFAULT 0;

CREATE OR REPLACE FUNCTION update_circle_total_sessions_count()
RETURNS TRIGGER AS $$
DECLARE
  affected_circle_id UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    affected_circle_id := OLD.circle_id;
  ELSE
    affected_circle_id := NEW.circle_id;
  END IF;

  UPDATE circles 
  SET cached_sessions_count = (
    SELECT COUNT(*) 
    FROM circle_sessions
    WHERE circle_id = affected_circle_id
    AND deleted_at IS NULL
  ) 
  WHERE id = affected_circle_id;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS circle_total_sessions_count_trigger ON circle_sessions;
CREATE TRIGGER circle_total_sessions_count_trigger
AFTER INSERT OR DELETE OR UPDATE OF deleted_at ON circle_sessions
FOR EACH ROW EXECUTE FUNCTION update_circle_total_sessions_count();

-- Backfill
UPDATE circles SET cached_sessions_count = (
  SELECT COUNT(*) 
  FROM circle_sessions 
  WHERE circle_id = circles.id 
  AND deleted_at IS NULL
);

-- Index
CREATE INDEX IF NOT EXISTS idx_circles_cached_sessions_count ON circles(cached_sessions_count);
